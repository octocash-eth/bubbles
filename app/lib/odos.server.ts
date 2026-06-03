import type { Address, Hex } from "viem";
import { getOdosApiKey } from "~/lib/env.server";

/**
 * Minimal, server-side Odos integration for bubbles payouts.
 *
 * Unlike octocash's client-side `odos.ts` (which drives an EIP-5792 wallet,
 * swaps ERC20 -> token, and applies a referral fee), this module only ever
 * sells the chain's *native* currency into a basket of tokens and delivers the
 * output straight to the claimant via Odos's `receiver`. Native input needs no
 * ERC20 approval, and bubbles takes no referral fee, so the flow collapses to a
 * single quote + assemble that yields one `{ to, data, value }` transaction the
 * treasury wallet broadcasts directly.
 *
 * Mirrors octocash's `odos-client.ts` host/header handling: when `ODOS_API_KEY`
 * is set, `/sor/*` calls go to the monetized `enterprise-api.odos.xyz` host with
 * the `x-api-key` header; otherwise the public `api.odos.xyz` host is used.
 * Being server-side, no CORS proxy is needed (octocash tunnels browser calls
 * through one). The token catalog stays on the free public host either way.
 */

/** Odos native-token sentinel address (used for both quote input and pricing). */
export const NATIVE_SENTINEL: Address = "0x0000000000000000000000000000000000000000";

const ODOS_PUBLIC_HOST = "https://api.odos.xyz";
const ODOS_ENTERPRISE_HOST = "https://enterprise-api.odos.xyz";

/** Base host for the rate-limited/monetized `/sor/*` endpoints. */
function odosBaseUrl(): string {
  return getOdosApiKey() ? ODOS_ENTERPRISE_HOST : ODOS_PUBLIC_HOST;
}

/** Headers for `/sor/*` calls, adding `x-api-key` when a key is configured. */
function odosHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const key = getOdosApiKey();
  if (key) headers["x-api-key"] = key;
  return headers;
}

/**
 * Slippage tolerance for the swap. A little higher than octocash's 0.3% because
 * the output basket is randomly chosen and can include thinner-liquidity tokens.
 */
const SLIPPAGE_LIMIT_PERCENT = 0.5;

interface OdosTokenInfo {
  symbol: string;
  decimals: number;
}

// Odos `/token?query=&chainId=N` returns an array of catalog entries.
interface OdosTokenCatalogEntry {
  address: string;
  chainId: string;
  symbol: string;
  name: string;
  decimals: number;
  isWhitelisted: boolean;
}

interface OdosQuoteResponse {
  pathId: string;
}

interface OdosAssembleResponse {
  transaction: {
    to: Address;
    data: Hex;
    value: string;
  };
}

/** Per-chain token list cache. The Odos token universe is effectively static. */
const tokenListCache = new Map<number, Map<Address, OdosTokenInfo>>();

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: odosHeaders({ "Content-Type": "application/json", accept: "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Odos request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetches (and caches) the Odos-supported token catalog for a chain, excluding
 * the native sentinel so callers only ever pick ERC20 outputs. The catalog is a
 * free public read endpoint (no API key / enterprise host needed).
 */
export async function fetchOdosTokenList(chainId: number): Promise<Map<Address, OdosTokenInfo>> {
  const cached = tokenListCache.get(chainId);
  if (cached) return cached;

  const url = new URL(`${ODOS_PUBLIC_HOST}/token`);
  url.searchParams.set("query", "");
  url.searchParams.set("chainId", String(chainId));

  const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Odos /token failed for chain ${chainId} (${res.status}): ${text}`);
  }
  const entries = (await res.json()) as OdosTokenCatalogEntry[];

  const list = new Map<Address, OdosTokenInfo>();
  for (const entry of entries) {
    const addr = entry.address as Address;
    if (addr.toLowerCase() === NATIVE_SENTINEL.toLowerCase()) continue;
    list.set(addr, { symbol: entry.symbol, decimals: entry.decimals });
  }
  tokenListCache.set(chainId, list);
  return list;
}

export interface RandomToken {
  address: Address;
  symbol: string;
}

/** Fisher-Yates partial shuffle: pick `count` distinct random tokens. */
export async function pickRandomTokens(chainId: number, count: number): Promise<RandomToken[]> {
  const list = await fetchOdosTokenList(chainId);
  const entries = Array.from(list.entries());
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return entries.slice(0, Math.min(count, entries.length)).map(([address, info]) => ({
    address,
    symbol: info.symbol,
  }));
}

/**
 * Random positive weights normalized to sum to 1, giving each output token a
 * random share of the swapped value.
 */
export function randomProportions(count: number): number[] {
  const weights = Array.from({ length: count }, () => Math.random() + 0.01);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}

export interface NativeSwapTx {
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * Builds a single Odos transaction that sells `valueWei` of native currency
 * into `outputs` (token address + proportion) and sends the proceeds to
 * `recipient`. The treasury (`treasury`) is the `userAddr`/sender; `receiver`
 * routes the output tokens to the claimant instead of back to the treasury.
 */
export async function buildNativeSwapTx({
  chainId,
  treasury,
  recipient,
  valueWei,
  outputs,
}: {
  chainId: number;
  treasury: Address;
  recipient: Address;
  valueWei: bigint;
  outputs: { address: Address; proportion: number }[];
}): Promise<NativeSwapTx> {
  const quoteBody = {
    chainId,
    inputTokens: [{ tokenAddress: NATIVE_SENTINEL, amount: valueWei.toString() }],
    outputTokens: outputs.map((o) => ({ tokenAddress: o.address, proportion: o.proportion })),
    userAddr: treasury,
    slippageLimitPercent: SLIPPAGE_LIMIT_PERCENT,
    referralCode: 0,
    disableRFQs: true,
    compact: false,
  };

  const quote = await postJson<OdosQuoteResponse>(`${odosBaseUrl()}/sor/quote/v3`, quoteBody);

  const assembled = await postJson<OdosAssembleResponse>(`${odosBaseUrl()}/sor/assemble`, {
    userAddr: treasury,
    pathId: quote.pathId,
    simulate: false,
    receiver: recipient,
  });

  const { to, data, value } = assembled.transaction;
  return { to, data, value: BigInt(value) };
}
