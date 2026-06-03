import { countUnusedKeys } from "~/lib/kv.server";
import { getTreasuryAddress, getTreasuryBalances } from "~/lib/treasury.server";

import type { Route } from "./+types/api.treasury";

/**
 * Public read-only endpoint: reports the treasury address to recharge, how many
 * keys are still unused, and the current native balance per payout chain.
 * Everything here is already public on-chain, so no auth is required.
 */
export async function loader(_args: Route.LoaderArgs) {
  const address = getTreasuryAddress();
  if (!address) {
    return Response.json({ error: "Server misconfigured: BUBBLES_PRIVATE_KEY is unset" }, { status: 500 });
  }

  const [unusedKeys, balances] = await Promise.all([countUnusedKeys(), getTreasuryBalances()]);

  return Response.json({
    address,
    unusedKeys,
    chains: balances.map((b) => ({
      chain: b.slug,
      chainId: b.chainId,
      balance: b.balance === null ? null : b.balance.toString(),
      ...("error" in b && b.error ? { error: b.error } : {}),
    })),
  });
}
