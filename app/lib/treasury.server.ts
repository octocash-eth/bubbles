import {
  type Account,
  type Address,
  createPublicClient,
  createWalletClient,
  type Hash,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { PAYOUT_CHAINS, type PayoutChain } from "~/lib/chains.server";
import { getBubblesPrivateKey, getRpcUrl } from "~/lib/env.server";
import {
  buildNativeSwapTx,
  getTokenPool,
  type NativeSwapTx,
  OdosRoutingError,
  type RandomToken,
  randomProportions,
} from "~/lib/odos.server";

/**
 * Native payouts are signed by a single treasury EOA derived from
 * `BUBBLES_PRIVATE_KEY`. The same address is valid on every payout chain, so
 * the operator funds one address per network and we reuse the same account for
 * balance reads and sends.
 */

// Gas a plain native transfer costs, plus a generous estimate for the Odos swap
// tx (sells native into a random token basket — routing through aggregators is
// far heavier than a transfer). Both are reserved per chain, times a safety
// multiplier for gas-price drift between estimate and inclusion, so the
// treasury never strands itself mid-payout.
const TRANSFER_GAS = 21_000n;
const SWAP_GAS = 400_000n;
const GAS_RESERVE_MULTIPLIER = 3n;

// Each claim delivers the native currency (always present) plus this many
// random tokens per chain. Odos supports up to 6 outputs in one swap.
const RANDOM_TOKEN_COUNT = 5;
// Fraction of the per-chain payout kept as native, randomized per claim within
// [10%, 20%]; the remainder is swapped into the random token basket.
const NATIVE_KEEP_MIN_BPS = 1000;
const NATIVE_KEEP_MAX_BPS = 2000;
// Max Odos quote attempts per chain before falling back to an all-native
// payout. Each attempt either succeeds, surgically drops one unroutable token
// and retries the rest of the basket, or (on a non-routing error) gives up — so
// this budget mostly bounds how many illiquid picks we'll skip past.
const MAX_SWAP_ATTEMPTS = 10;

let cachedAccount: Account | null = null;
const publicClients = new Map<number, PublicClient>();
const walletClients = new Map<number, WalletClient>();

/**
 * Returns the treasury account, or null when `BUBBLES_PRIVATE_KEY` is unset so
 * callers can surface a clean "misconfigured" error.
 */
export function getTreasuryAccount(): Account | null {
  if (cachedAccount) return cachedAccount;
  const pk = getBubblesPrivateKey();
  if (!pk) return null;
  cachedAccount = privateKeyToAccount(pk);
  return cachedAccount;
}

export function getTreasuryAddress(): Address | null {
  return getTreasuryAccount()?.address ?? null;
}

function getPublicClient(payout: PayoutChain): PublicClient {
  const cached = publicClients.get(payout.chain.id);
  if (cached) return cached;
  const url = getRpcUrl(payout.rpcEnv);
  const client = createPublicClient({
    chain: payout.chain,
    transport: http(url),
  }) as PublicClient;
  publicClients.set(payout.chain.id, client);
  return client;
}

function getWalletClient(payout: PayoutChain, account: Account): WalletClient {
  const cached = walletClients.get(payout.chain.id);
  if (cached) return cached;
  const url = getRpcUrl(payout.rpcEnv);
  const client = createWalletClient({
    account,
    chain: payout.chain,
    transport: http(url),
  });
  walletClients.set(payout.chain.id, client);
  return client;
}

export type ChainBalance = {
  slug: string;
  chainId: number;
  balance: bigint;
};

/**
 * Reads the treasury native balance on every payout chain in parallel. A chain
 * whose RPC fails reports a `null` balance instead of failing the whole batch.
 */
export async function getTreasuryBalances(): Promise<
  Array<ChainBalance | { slug: string; chainId: number; balance: null; error: string }>
> {
  const address = getTreasuryAddress();
  if (!address) throw new Error("treasury: BUBBLES_PRIVATE_KEY is unset");

  return await Promise.all(
    PAYOUT_CHAINS.map(async (payout) => {
      try {
        const balance = await getPublicClient(payout).getBalance({ address });
        return { slug: payout.slug, chainId: payout.chain.id, balance };
      } catch (err) {
        return {
          slug: payout.slug,
          chainId: payout.chain.id,
          balance: null,
          error: err instanceof Error ? err.message : "balance read failed",
        };
      }
    }),
  );
}

/**
 * Proportional native payout: `(balance - gasReserve) / unusedKeys`, clamped to
 * zero. `unusedKeys` includes the key being claimed, so the treasury never
 * overdraws. The gas reserve keeps enough native behind to actually broadcast
 * this transfer.
 */
export function computePayout(balance: bigint, gasPriceWei: bigint, unusedKeys: number): bigint {
  if (unusedKeys <= 0) return 0n;
  // Each payout broadcasts two txs per chain: the native transfer and the Odos
  // swap. Reserve gas for both so the swap can't strand the treasury.
  const reserve = (TRANSFER_GAS + SWAP_GAS) * gasPriceWei * GAS_RESERVE_MULTIPLIER;
  const spendable = balance - reserve;
  if (spendable <= 0n) return 0n;
  const payout = spendable / BigInt(unusedKeys);
  return payout > 0n ? payout : 0n;
}

export type PayoutResult = {
  chain: string;
  chainId: number;
  /** Native amount sent directly to the claimant, as a wei integer string. */
  amount: string;
  txHash?: Hash;
  /** Native amount routed into the random token basket, as a wei integer string. */
  swapAmount?: string;
  /** Tx hash of the Odos swap that delivered the random tokens. */
  swapTxHash?: Hash;
  /** Random tokens delivered to the claimant via the swap. */
  tokens?: RandomToken[];
  error?: string;
};

/**
 * Sends an exact native amount from the treasury to `to` on a single payout
 * chain. Used by the admin "set balance" control to refund the operator the
 * difference when they lower a chain's target balance. Throws on misconfig,
 * unknown chain, non-positive amount, or RPC failure so the caller can surface
 * a clean error. Broadcast without waiting for confirmation.
 */
export async function sendFromTreasury(chainId: number, to: Address, value: bigint): Promise<Hash> {
  const account = getTreasuryAccount();
  if (!account) throw new Error("treasury: BUBBLES_PRIVATE_KEY is unset");
  if (value <= 0n) throw new Error("treasury: amount must be positive");
  const payout = PAYOUT_CHAINS.find((p) => p.chain.id === chainId);
  if (!payout) throw new Error(`treasury: unsupported chain ${chainId}`);
  return await getWalletClient(payout, account).sendTransaction({
    account,
    chain: payout.chain,
    to,
    value,
  });
}

/** Random native-keep fraction in basis points, uniform in [MIN, MAX]. */
function randomNativeKeepBps(): number {
  const span = NATIVE_KEEP_MAX_BPS - NATIVE_KEEP_MIN_BPS;
  return NATIVE_KEEP_MIN_BPS + Math.floor(Math.random() * (span + 1));
}

/**
 * Builds (but does not broadcast) a single Odos swap that sells `swapValue`
 * native into a basket of `RANDOM_TOKEN_COUNT` random tokens delivered to `to`.
 *
 * Odos rejects a multi-output quote if *any* output token is unroutable, and the
 * chain catalog is full of illiquid/receipt tokens — so re-rolling the whole
 * basket rarely converges. Instead we walk a shuffled candidate pool: when Odos
 * names an unroutable token, we drop just that token and backfill from the pool,
 * keeping the routable picks. Returns null when we can't assemble a routable
 * basket so the caller can fall back to an all-native payout.
 *
 * Broadcasting is left to the caller so the (slow) quote/assemble can be awaited
 * for the claim response while the actual send happens in the background.
 */
async function buildSwapBasket(
  payout: PayoutChain,
  account: Account,
  to: Address,
  swapValue: bigint,
): Promise<{ swapTx: NativeSwapTx; tokens: RandomToken[] } | null> {
  const chainId = payout.chain.id;

  let pool: RandomToken[];
  try {
    pool = await getTokenPool(chainId);
  } catch (err) {
    console.error(`payout: odos token list failed on ${payout.slug}`, err);
    return null;
  }
  if (pool.length === 0) return null;

  // Walk the shuffled pool, topping the basket up to RANDOM_TOKEN_COUNT and
  // skipping any token already proven unroutable.
  const dead = new Set<string>();
  const basket: RandomToken[] = [];
  let cursor = 0;
  const refill = () => {
    while (basket.length < RANDOM_TOKEN_COUNT && cursor < pool.length) {
      const cand = pool[cursor++];
      if (!dead.has(cand.address.toLowerCase())) basket.push(cand);
    }
  };
  refill();

  for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS && basket.length > 0; attempt++) {
    try {
      const proportions = randomProportions(basket.length);
      const outputs = basket.map((t, i) => ({ address: t.address, proportion: proportions[i] }));

      const swapTx = await buildNativeSwapTx({
        chainId,
        treasury: account.address,
        recipient: to,
        valueWei: swapValue,
        outputs,
      });

      return { swapTx, tokens: [...basket] };
    } catch (err) {
      if (err instanceof OdosRoutingError && err.unroutableToken) {
        // Drop just the unroutable token and backfill the basket from the pool.
        const bad = err.unroutableToken.toLowerCase();
        dead.add(bad);
        const idx = basket.findIndex((t) => t.address.toLowerCase() === bad);
        if (idx >= 0) basket.splice(idx, 1);
        refill();
        continue;
      }
      // Non-routing failure (RPC, rate limit after retries, etc.) — re-rolling
      // won't help, so fall back to native.
      console.error(`payout: odos swap failed on ${payout.slug}`, err);
      return null;
    }
  }
  return null;
}

/** Fire-and-forget a broadcast so the claim response isn't blocked on it. */
function broadcastInBackground(label: string, send: () => Promise<unknown>): void {
  void send().catch((err) => console.error(`payout: broadcast failed (${label})`, err));
}

/**
 * Best-effort payout across every chain. Each chain delivers native currency
 * (always present) plus a basket of random tokens swapped via Odos and sent
 * straight to the claimant. Marks nothing in KV and never throws — each chain is
 * isolated so one RPC/funding/routing failure can't block the others or roll
 * back an already-claimed key.
 *
 * The slow part (the Odos quote/assemble) is awaited because its token basket is
 * returned to the claimant; the resulting on-chain sends are broadcast in the
 * background so the claim response returns as soon as the basket is known.
 */
export async function sendPayouts(to: Address, unusedKeys: number): Promise<PayoutResult[]> {
  const account = getTreasuryAccount();
  if (!account) throw new Error("treasury: BUBBLES_PRIVATE_KEY is unset");

  return await Promise.all(
    PAYOUT_CHAINS.map(async (payout): Promise<PayoutResult> => {
      const base = { chain: payout.slug, chainId: payout.chain.id };
      try {
        const publicClient = getPublicClient(payout);
        const walletClient = getWalletClient(payout, account);
        // Manage the nonce explicitly so the two back-to-back sends from the same
        // EOA don't collide on the pending nonce.
        const [balance, gasPrice, nonce] = await Promise.all([
          publicClient.getBalance({ address: account.address }),
          publicClient.getGasPrice(),
          publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
        ]);

        const amount = computePayout(balance, gasPrice, unusedKeys);
        if (amount <= 0n) {
          return { ...base, amount: "0", error: "nothing to send after gas reserve" };
        }

        // Keep a random 10-20% as native (always present) and swap the rest into
        // the random token basket.
        const keepBps = randomNativeKeepBps();
        const nativeKeep = (amount * BigInt(keepBps)) / 10_000n;
        const swapAmount = amount - nativeKeep;

        if (swapAmount <= 0n) {
          broadcastInBackground(`native ${payout.slug}`, () =>
            walletClient.sendTransaction({ account, chain: payout.chain, to, value: nativeKeep, nonce }),
          );
          return { ...base, amount: nativeKeep.toString() };
        }

        const swap = await buildSwapBasket(payout, account, to, swapAmount);
        if (swap) {
          // Broadcast native first, then the swap (nonce+1) only after the native
          // send is accepted, so the swap isn't stuck behind a missing nonce.
          broadcastInBackground(`payout ${payout.slug}`, async () => {
            await walletClient.sendTransaction({ account, chain: payout.chain, to, value: nativeKeep, nonce });
            await walletClient.sendTransaction({
              account,
              chain: payout.chain,
              to: swap.swapTx.to,
              data: swap.swapTx.data,
              value: swap.swapTx.value,
              nonce: nonce + 1,
            });
          });
          return {
            ...base,
            amount: nativeKeep.toString(),
            swapAmount: swapAmount.toString(),
            tokens: swap.tokens,
          };
        }

        // Odos couldn't route a basket — send the whole amount as native so the
        // claimant is still fully paid.
        broadcastInBackground(`native-fallback ${payout.slug}`, () =>
          walletClient.sendTransaction({ account, chain: payout.chain, to, value: amount, nonce }),
        );
        return {
          ...base,
          amount: amount.toString(),
          error: "odos routing failed; sent remainder as native",
        };
      } catch (err) {
        return {
          ...base,
          amount: "0",
          error: err instanceof Error ? err.message : "send failed",
        };
      }
    }),
  );
}
