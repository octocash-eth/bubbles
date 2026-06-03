/**
 * Shared admin auth: the `BUBBLES_SECRET` bearer check (used by the keys API)
 * plus an HttpOnly cookie session for the `/admin` dashboard so the raw secret
 * never has to live in the browser.
 */
import { createCookieSessionStorage } from "react-router";

import { getBubblesSecret } from "~/lib/env.server";

/**
 * Constant-time(ish) string compare. Deno's `crypto.timingSafeEqual` only
 * accepts ArrayBufferViews so we hash both inputs first — equal hashes ⇒ equal
 * inputs (collisions excluded). For an admin-only check a plain `===` would do,
 * but this costs nothing and avoids future regrets.
 */
export async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
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

/**
 * Verifies a presented secret against `BUBBLES_SECRET`. Returns false when the
 * secret is unset so callers fail closed; check `getBubblesSecret()` separately
 * if you need to distinguish "wrong secret" from "server misconfigured".
 */
export async function verifySecret(presented: string): Promise<boolean> {
  const expected = getBubblesSecret();
  if (!expected || !presented) return false;
  return await timingSafeStringEqual(presented, expected);
}

const IS_PROD = Deno.env.get("DENO_ENV") === "production" ||
  Deno.env.get("NODE_ENV") === "production";

// Sign the session cookie with the same secret that gates admin access. When
// the secret rotates, existing admin sessions are invalidated — which is the
// behavior we want.
const sessionStorage = createCookieSessionStorage<{ admin: boolean }>({
  cookie: {
    name: "bubbles_admin",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: IS_PROD,
    maxAge: 60 * 60 * 8, // 8 hours
    secrets: [getBubblesSecret() ?? "bubbles-admin-dev-secret"],
  },
});

export function getAdminSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

export async function isAdmin(request: Request): Promise<boolean> {
  const session = await getAdminSession(request);
  return session.get("admin") === true;
}

/** Returns a `Set-Cookie` header value that marks the session as authenticated. */
export async function commitAdminSession(request: Request): Promise<string> {
  const session = await getAdminSession(request);
  session.set("admin", true);
  return await sessionStorage.commitSession(session);
}

/** Returns a `Set-Cookie` header value that clears the admin session. */
export async function destroyAdminSession(request: Request): Promise<string> {
  const session = await getAdminSession(request);
  return await sessionStorage.destroySession(session);
}
