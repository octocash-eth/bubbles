/**
 * Tiny env helpers so route loaders/actions don't sprinkle `Deno.env.get`
 * everywhere.
 */

export function getOctocashUrl(): string {
  return Deno.env.get("OCTOCASH_URL") || "https://octo.cash";
}

export function getBubblesSecret(): string | null {
  const v = Deno.env.get("BUBBLES_SECRET");
  return v && v.length > 0 ? v : null;
}

/**
 * Treasury private key used to sign native payouts. Returned as a 0x-prefixed
 * hex string so it can be handed straight to viem's `privateKeyToAccount`.
 * Returns null when unset so callers can surface a clear "misconfigured"
 * error rather than crashing deep in viem.
 */
export function getBubblesPrivateKey(): `0x${string}` | null {
  const v = Deno.env.get("BUBBLES_PRIVATE_KEY")?.trim();
  if (!v) return null;
  const hex = v.startsWith("0x") ? v : `0x${v}`;
  return hex as `0x${string}`;
}

/**
 * Optional per-chain RPC override. Env var name is keyed off the viem chain id
 * via the mapping in `chains.server.ts`; an empty/unset value falls back to the
 * chain's default public RPC.
 */
export function getRpcUrl(envName: string): string | undefined {
  const v = Deno.env.get(envName)?.trim();
  return v && v.length > 0 ? v : undefined;
}
