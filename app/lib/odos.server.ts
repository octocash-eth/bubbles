import type { Address, Hex } from "viem";
import { getOdosApiKey } from "~/lib/env.server";
import { SAFE_TOKENS } from "~/lib/safe-tokens";

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

// Odos enforces per-second/per-minute rate limits per API key. Rather than
// serialize every request (which made a 4-chain claim ~3x slower), we cap how
// many Odos requests are in flight at once — so all chains route concurrently
// while staying under the burst limit — and retry transient failures (429s and
// 5xx) with exponential backoff.
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_TRANSIENT_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 300;

// Odos rejects a quote whose output basket contains a token it can't route,
// returning HTTP 400 with this code and the offending address in `detail`.
const ODOS_NO_ROUTE_CODE = 4016;

/**
 * Raised when Odos can't route one of the requested output tokens. Carries the
 * offending token address so the caller can drop just that token and retry the
 * rest of the basket instead of throwing the whole basket away.
 */
export class OdosRoutingError extends Error {
  readonly unroutableToken: Address | null;
  constructor(message: string, unroutableToken: Address | null) {
    super(message);
    this.name = "OdosRoutingError";
    this.unroutableToken = unroutableToken;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// FIFO concurrency gate shared by every Odos request across all in-flight
// payouts. Lets up to MAX_CONCURRENT_REQUESTS run at once; the rest queue.
let inFlight = 0;
const waiters: Array<() => void> = [];
function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_REQUESTS) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}
function releaseSlot(): void {
  const next = waiters.shift();
  // Hand the slot directly to the next waiter (count unchanged), or free it.
  if (next) next();
  else inFlight--;
}

/** True for responses worth retrying: rate limits and transient server errors. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Extracts the offending token address and error code from an Odos error body. */
function parseOdosError(body: string): { code: number | null; token: Address | null } {
  try {
    const json = JSON.parse(body) as { errorCode?: number; detail?: string };
    const match = json.detail?.match(/0x[0-9a-fA-F]{40}/);
    return { code: json.errorCode ?? null, token: (match?.[0] as Address) ?? null };
  } catch {
    return { code: null, token: null };
  }
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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let retryDelay = -1;
    await acquireSlot();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: odosHeaders({ "Content-Type": "application/json", accept: "application/json" }),
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;

      const text = await res.text().catch(() => "");
      // Back off and retry transient rate-limit / server errors before giving up.
      if (isTransientStatus(res.status) && attempt < MAX_TRANSIENT_RETRIES) {
        retryDelay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      } else {
        // Surface an unroutable token as a typed error so the caller can drop
        // just that token rather than abandoning the whole basket.
        const { code, token } = parseOdosError(text);
        if (code === ODOS_NO_ROUTE_CODE) {
          throw new OdosRoutingError(`Odos can't route token ${token ?? "(unknown)"}`, token);
        }
        throw new Error(`Odos request failed (${res.status}): ${text}`);
      }
    } finally {
      releaseSlot();
    }
    // Back off outside the concurrency gate so we don't hold a slot while waiting.
    await sleep(retryDelay);
  }
}

export interface RandomToken {
  address: Address;
  symbol: string;
}

/** Fisher-Yates shuffle (in place). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Returns the chain's curated safe-token allowlist as a freshly shuffled
 * candidate pool. Callers walk the pool in order, dropping any token Odos
 * reports as unroutable and backfilling from later in the pool — though with a
 * vetted allowlist that fallback should rarely fire.
 */
export async function getTokenPool(chainId: number): Promise<RandomToken[]> {
  const list = SAFE_TOKENS[chainId] ?? [];
  return shuffle(list.map((t) => ({ address: t.address, symbol: t.symbol })));
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
