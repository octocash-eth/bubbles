import { type Address, isAddress } from "viem";

import { isAdmin } from "~/lib/auth.server";
import { PAYOUT_CHAINS } from "~/lib/chains.server";
import { getTreasuryAddress, sendFromTreasury } from "~/lib/treasury.server";

import type { Route } from "./+types/api.withdraw";

/**
 * Admin-only: refunds the connected operator the difference when they lower a
 * chain's target balance. Gated by the admin session cookie, which is signed
 * with `BUBBLES_SECRET`, so only someone who proved the secret can move
 * treasury funds. The amount is supplied in wei to avoid float drift.
 */

type WithdrawBody = {
  chainId?: number;
  to?: string;
  /** Native amount to send, as a wei integer string. */
  amount?: string;
};

const SUPPORTED_CHAIN_IDS = new Set(PAYOUT_CHAINS.map((p) => p.chain.id));

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!(await isAdmin(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!getTreasuryAddress()) {
    return Response.json({ error: "Server misconfigured: BUBBLES_PRIVATE_KEY is unset" }, { status: 500 });
  }

  let body: WithdrawBody;
  try {
    body = (await request.json()) as WithdrawBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { chainId, to, amount } = body;

  if (typeof chainId !== "number" || !SUPPORTED_CHAIN_IDS.has(chainId)) {
    return Response.json({ error: "Unsupported chainId" }, { status: 400 });
  }
  if (typeof to !== "string" || !isAddress(to)) {
    return Response.json({ error: "Invalid recipient address" }, { status: 400 });
  }

  let value: bigint;
  try {
    value = BigInt(amount ?? "");
  } catch {
    return Response.json({ error: "amount must be a wei integer string" }, { status: 400 });
  }
  if (value <= 0n) {
    return Response.json({ error: "amount must be positive" }, { status: 400 });
  }

  try {
    const txHash = await sendFromTreasury(chainId, to as Address, value);
    return Response.json({ txHash }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "withdraw failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
