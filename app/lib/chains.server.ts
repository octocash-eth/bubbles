import type { Chain } from "viem";
import { arbitrum, base, optimism, polygon } from "viem/chains";

/**
 * Chains the treasury pays out on, in a stable order. Each entry pairs a viem
 * chain with the env var name used to override its RPC endpoint
 * (see `getRpcUrl` in `env.server.ts`). When the env var is unset, viem's
 * default public RPC for the chain is used.
 *
 * One treasury EOA address is valid on every chain here, so the operator only
 * needs to fund a single address per network.
 */
export type PayoutChain = {
  chain: Chain;
  /** Human-readable slug used in API responses. */
  slug: string;
  /** Env var holding an optional RPC URL override. */
  rpcEnv: string;
};

export const PAYOUT_CHAINS: readonly PayoutChain[] = [
  { chain: optimism, slug: "optimism", rpcEnv: "OPTIMISM_RPC_URL" },
  { chain: base, slug: "base", rpcEnv: "BASE_RPC_URL" },
  { chain: arbitrum, slug: "arbitrum", rpcEnv: "ARBITRUM_RPC_URL" },
  { chain: polygon, slug: "polygon", rpcEnv: "POLYGON_RPC_URL" },
] as const;
