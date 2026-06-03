import type { Address } from "viem";

/**
 * Shape of a key record stored in Deno KV.
 *
 * Keys live under:
 *   ["keys", "by_id", id] → KeyRecord
 *
 * Only one index is needed — lookups are always by id.
 */
export type KeyRecord = {
  id: string;
  status: "unused" | "claimed";
  createdAt: number;
  claimedAt?: number;
  claimedBy?: Address;
};

let cachedKv: Deno.Kv | null = null;

export async function getKv(): Promise<Deno.Kv> {
  if (cachedKv) return cachedKv;
  const path = (globalThis as { Deno?: typeof Deno }).Deno?.env.get("DENO_KV_PATH");
  cachedKv = await Deno.openKv(path || undefined);
  return cachedKv;
}

const ID_KEY = (id: string) => ["keys", "by_id", id] as const;

// URL-safe base58 alphabet (no 0, O, I, l). 12 chars ≈ 70 bits of entropy —
// plenty for a one-shot share token. crypto.getRandomValues is rejection-sampled
// to avoid modulo bias against the 58-symbol alphabet.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const KEY_LENGTH = 12;

function generateKeyId(): string {
  const out: string[] = [];
  const buf = new Uint8Array(KEY_LENGTH * 2);
  while (out.length < KEY_LENGTH) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (out.length >= KEY_LENGTH) break;
      // Discard values that would skew the distribution (256 % 58 ≠ 0).
      if (byte >= 232) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
    }
  }
  return out.join("");
}

export async function createKey(): Promise<KeyRecord> {
  const kv = await getKv();
  // Retry on the astronomically unlikely id collision so callers never see a
  // 500 for a fixable cause.
  for (let attempt = 0; attempt < 5; attempt++) {
    const record: KeyRecord = {
      id: generateKeyId(),
      status: "unused",
      createdAt: Date.now(),
    };
    const res = await kv.atomic().check({ key: ID_KEY(record.id), versionstamp: null }).set(ID_KEY(record.id), record).commit();
    if (res.ok) return record;
  }
  throw new Error("kv: failed to allocate a unique key id after 5 attempts");
}

export async function createKeys(n: number): Promise<KeyRecord[]> {
  const records: KeyRecord[] = [];
  for (let i = 0; i < n; i++) {
    records.push(await createKey());
  }
  return records;
}

export async function getKey(id: string): Promise<KeyRecord | null> {
  const kv = await getKv();
  const entry = await kv.get<KeyRecord>(ID_KEY(id));
  return entry.value;
}

/**
 * Counts keys still in the `unused` state. Used as the payout denominator so
 * the treasury share scales with how many keys remain. Key volume is small
 * (one-shot share tokens), so a prefix scan is fine — no separate counter to
 * keep in sync.
 */
export async function countUnusedKeys(): Promise<number> {
  const kv = await getKv();
  let count = 0;
  for await (const entry of kv.list<KeyRecord>({ prefix: ["keys", "by_id"] })) {
    if (entry.value.status === "unused") count++;
  }
  return count;
}

/**
 * Returns every key record, newest first. Backs the admin dashboard table.
 * Key volume is small (one-shot share tokens), so a full prefix scan is fine.
 */
export async function listKeys(): Promise<KeyRecord[]> {
  const kv = await getKv();
  const out: KeyRecord[] = [];
  for await (const entry of kv.list<KeyRecord>({ prefix: ["keys", "by_id"] })) {
    out.push(entry.value);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export type ClaimResult =
  | { ok: true; record: KeyRecord }
  | { ok: false; reason: "not_found" | "already_claimed" };

export async function claimKey(id: string, address: Address): Promise<ClaimResult> {
  const kv = await getKv();
  const entry = await kv.get<KeyRecord>(ID_KEY(id));
  if (!entry.value) return { ok: false, reason: "not_found" };
  if (entry.value.status === "claimed") return { ok: false, reason: "already_claimed" };

  const next: KeyRecord = {
    ...entry.value,
    status: "claimed",
    claimedAt: Date.now(),
    claimedBy: address,
  };
  // Atomic check on the versionstamp protects against a second concurrent
  // claim of the same key racing past the read above.
  const res = await kv.atomic().check(entry).set(ID_KEY(id), next).commit();
  if (!res.ok) return { ok: false, reason: "already_claimed" };
  return { ok: true, record: next };
}
