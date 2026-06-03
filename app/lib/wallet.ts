import { type Chain, http } from "viem";
import { arbitrum, base, optimism, polygon } from "viem/chains";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";

/**
 * Browser-side wallet wiring for the admin "set balance" controls. Server
 * payouts and refunds still use the treasury EOA in `treasury.server.ts`; this
 * is only the operator's connected wallet topping the treasury up.
 *
 * Injected-only by design — no WalletConnect, so no project id / env vars.
 */

/** Chains the admin can adjust, matching `PAYOUT_CHAINS` order. */
export const WALLET_CHAINS = [optimism, base, arbitrum, polygon] as const;

const CHAIN_BY_ID = new Map<number, Chain>(WALLET_CHAINS.map((c) => [c.id, c]));

export function getWalletChain(chainId: number): Chain | undefined {
  return CHAIN_BY_ID.get(chainId);
}

export const walletConfig = createConfig({
  chains: WALLET_CHAINS,
  connectors: [injected()],
  transports: {
    [optimism.id]: http(),
    [base.id]: http(),
    [arbitrum.id]: http(),
    [polygon.id]: http(),
  },
  ssr: true,
});
