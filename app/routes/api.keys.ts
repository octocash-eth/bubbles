import { createKeys } from "~/lib/kv.server";
import { getBubblesSecret } from "~/lib/env.server";
import { timingSafeStringEqual } from "~/lib/auth.server";

import type { Route } from "./+types/api.keys";

type CreateBody = {
  n?: number;
};

const MAX_KEYS_PER_REQUEST = 100;

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
