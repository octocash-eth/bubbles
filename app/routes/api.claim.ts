import { resolveAddress } from "~/lib/ens.server";
import { claimKey, countUnusedKeys } from "~/lib/kv.server";
import { getTreasuryAddress, sendPayouts } from "~/lib/treasury.server";

import type { Route } from "./+types/api.claim";

type ClaimBody = {
  key?: string;
  address?: string;
};

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: ClaimBody;
  try {
    body = (await request.json()) as ClaimBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { key, address } = body;
  if (typeof key !== "string" || key.length === 0) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }
  if (typeof address !== "string" || address.length === 0) {
    return Response.json({ error: "address is required" }, { status: 400 });
  }

  const resolved = await resolveAddress(address);
  if (!resolved) {
    return Response.json({ error: "Could not resolve address or ENS name" }, { status: 400 });
  }

  // Count unused keys *before* claiming so the current key is included in the
  // payout denominator — this guarantees the treasury never overdraws.
  const unusedKeys = await countUnusedKeys();

  const result = await claimKey(key, resolved);
  if (!result.ok) {
    if (result.reason === "not_found") {
      return Response.json({ error: "Unknown key" }, { status: 404 });
    }
    return Response.json({ error: "Key already claimed" }, { status: 409 });
  }

  // The key is now in its terminal claimed state. Payouts are best-effort: a
  // misconfigured/empty treasury or a failing chain must not undo the claim.
  let payouts: Awaited<ReturnType<typeof sendPayouts>> = [];
  if (getTreasuryAddress()) {
    try {
      payouts = await sendPayouts(resolved, unusedKeys);
    } catch (err) {
      console.error("claim: payout dispatch failed", err);
    }
  } else {
    console.error("claim: BUBBLES_PRIVATE_KEY is unset; skipping payouts");
  }

  return Response.json({ address: resolved, payouts }, { status: 200 });
}
