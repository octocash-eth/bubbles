import { createKeys } from "~/lib/kv.server";
import { getBubblesSecret } from "~/lib/env.server";

import type { Route } from "./+types/api.keys";

type CreateBody = {
  n?: number;
};

const MAX_KEYS_PER_REQUEST = 100;

/**
 * Constant-time(ish) string compare. Deno's `crypto.timingSafeEqual` only
 * accepts ArrayBufferViews so we hash both inputs first — equal hashes ⇒ equal
 * inputs (collisions excluded). For an admin-only API a plain `===` would do,
 * but this costs nothing and avoids future regrets.
 */
async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const av = new Uint8Array(ah);
  const bv = new Uint8Array(bh);
  if (av.length !== bv.length) return false;
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const expected = getBubblesSecret();
  if (!expected) {
    // Misconfigured server — treat as 500 so an admin notices, rather than
    // silently letting anyone mint keys.
    return Response.json({ error: "Server misconfigured: BUBBLES_SECRET is unset" }, { status: 500 });
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!presented || !(await timingSafeStringEqual(presented, expected))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateBody = {};
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      body = (await request.json()) as CreateBody;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const rawN = body.n ?? 1;
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > MAX_KEYS_PER_REQUEST) {
    return Response.json(
      { error: `n must be an integer between 1 and ${MAX_KEYS_PER_REQUEST}` },
      { status: 400 },
    );
  }

  const records = await createKeys(rawN);
  return Response.json({ keys: records.map((r) => r.id) }, { status: 201 });
}
