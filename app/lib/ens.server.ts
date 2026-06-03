import { type Address, createPublicClient, getAddress, http, isAddress } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

let cachedClient: ReturnType<typeof createPublicClient> | null = null;

function getClient() {
  if (cachedClient) return cachedClient;
  const rpc = (globalThis as { Deno?: typeof Deno }).Deno?.env.get("MAINNET_RPC_URL") || undefined;
  cachedClient = createPublicClient({
    chain: mainnet,
    transport: http(rpc),
  });
  return cachedClient;
}

export async function resolveAddress(input: string): Promise<Address | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (isAddress(trimmed)) return getAddress(trimmed);

  // Loose ENS shape check — anything with a dot and a 2+ char tld is treated
  // as a name. Viem's `normalize` will reject malformed names below.
  if (/\.[a-z]{2,}$/i.test(trimmed)) {
    try {
      const name = normalize(trimmed);
      const addr = await getClient().getEnsAddress({ name });
      return addr ?? null;
    } catch {
      return null;
    }
  }

  return null;
}
