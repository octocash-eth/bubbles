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
import { buildNativeSwapTx, pickRandomTokens, type RandomToken, randomProportions } from "~/lib/odos.server";

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
// How many times to re-roll the random token basket when Odos can't route it
// (e.g. an illiquid pick) before falling back to an all-native payout.
const MAX_SWAP_ATTEMPTS = 3;

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
 * Builds and broadcasts a single Odos swap that sells `swapValue` native into a
 * random token basket delivered to `to`. Re-rolls the basket up to
 * `MAX_SWAP_ATTEMPTS` times when Odos can't route the picks. Returns null when
 * every attempt fails so the caller can fall back to an all-native payout.
 */
async function trySwapBasket(
  payout: PayoutChain,
  account: Account,
  to: Address,
  swapValue: bigint,
  nonce: number,
): Promise<{ swapTxHash: Hash; tokens: RandomToken[] } | null> {
  const chainId = payout.chain.id;
  for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS; attempt++) {
    try {
      const tokens = await pickRandomTokens(chainId, RANDOM_TOKEN_COUNT);
      if (tokens.length === 0) return null;
      const proportions = randomProportions(tokens.length);
      const outputs = tokens.map((t, i) => ({ address: t.address, proportion: proportions[i] }));

      const swapTx = await buildNativeSwapTx({
        chainId,
        treasury: account.address,
        recipient: to,
        valueWei: swapValue,
        outputs,
      });

      const swapTxHash = await getWalletClient(payout, account).sendTransaction({
        account,
        chain: payout.chain,
        to: swapTx.to,
        data: swapTx.data,
        value: swapTx.value,
        nonce,
      });
      return { swapTxHash, tokens };
    } catch (err) {
      console.error(`payout: odos swap attempt ${attempt + 1} failed on ${payout.slug}`, err);
    }
  }
  return null;
}

/**
 * Best-effort payout across every chain. Each chain delivers native currency
 * (always present) plus a basket of random tokens swapped via Odos and sent
 * straight to the claimant. Marks nothing in KV and never throws — each chain is
 * isolated so one RPC/funding/routing failure can't block the others or roll
 * back an already-claimed key. Transactions are broadcast without waiting for
 * confirmation.
 */
export async function sendPayouts(to: Address, unusedKeys: number): Promise<PayoutResult[]> {
  const account = getTreasuryAccount();
  if (!account) throw new Error("treasury: BUBBLES_PRIVATE_KEY is unset");

  return await Promise.all(
    PAYOUT_CHAINS.map(async (payout): Promise<PayoutResult> => {
      const base = { chain: payout.slug, chainId: payout.chain.id };
      try {
        const publicClient = getPublicClient(payout);
        const [balance, gasPrice] = await Promise.all([
          publicClient.getBalance({ address: account.address }),
          publicClient.getGasPrice(),
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

        const walletClient = getWalletClient(payout, account);
        // Manage the nonce explicitly so the two back-to-back sends from the same
        // EOA don't collide on the pending nonce.
        const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });

        const txHash = await walletClient.sendTransaction({
          account,
          chain: payout.chain,
          to,
          value: nativeKeep,
          nonce,
        });

        if (swapAmount <= 0n) {
          return { ...base, amount: nativeKeep.toString(), txHash };
        }

        const swap = await trySwapBasket(payout, account, to, swapAmount, nonce + 1);
        if (swap) {
          return {
            ...base,
            amount: nativeKeep.toString(),
            txHash,
            swapAmount: swapAmount.toString(),
            swapTxHash: swap.swapTxHash,
            tokens: swap.tokens,
          };
        }

        // Odos couldn't route the basket — fall back to sending the remainder as
        // native so the claimant is still fully paid.
        const fallbackHash = await walletClient.sendTransaction({
          account,
          chain: payout.chain,
          to,
          value: swapAmount,
          nonce: nonce + 1,
        });
        return {
          ...base,
          amount: amount.toString(),
          txHash: fallbackHash,
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
