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

/**
 * Native payouts are signed by a single treasury EOA derived from
 * `BUBBLES_PRIVATE_KEY`. The same address is valid on every payout chain, so
 * the operator funds one address per network and we reuse the same account for
 * balance reads and sends.
 */

// Gas a plain native transfer costs, plus a safety multiplier so the reserve
// comfortably covers this tx (and a little headroom for gas-price drift between
// the estimate and inclusion) without stranding the treasury.
const TRANSFER_GAS = 21_000n;
const GAS_RESERVE_MULTIPLIER = 3n;

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
  const reserve = TRANSFER_GAS * gasPriceWei * GAS_RESERVE_MULTIPLIER;
  const spendable = balance - reserve;
  if (spendable <= 0n) return 0n;
  const payout = spendable / BigInt(unusedKeys);
  return payout > 0n ? payout : 0n;
}

export type PayoutResult = {
  chain: string;
  chainId: number;
  amount: string;
  txHash?: Hash;
  error?: string;
};

/**
 * Best-effort native payout across every chain. Marks nothing in KV and never
 * throws — each chain is isolated so one RPC/funding failure can't block the
 * others or roll back an already-claimed key. Transactions are broadcast
 * without waiting for confirmation.
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

        const txHash = await getWalletClient(payout, account).sendTransaction({
          account,
          chain: payout.chain,
          to,
          value: amount,
        });
        return { ...base, amount: amount.toString(), txHash };
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
