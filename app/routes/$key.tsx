import * as React from "react";
import { redirect } from "react-router";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Modal } from "~/components/ui/modal";
import { getOctocashUrl } from "~/lib/env.server";
import { getKey } from "~/lib/kv.server";

import type { Route } from "./+types/$key";

export async function loader({ params }: Route.LoaderArgs) {
  const record = await getKey(params.key);
  if (!record) {
    return redirect(getOctocashUrl());
  }
  return {
    key: record.id,
    alreadyClaimed: record.status === "claimed",
    octocashUrl: getOctocashUrl(),
  };
}

type Stage = "form" | "throwing" | "delivered";

const THROWING_MIN_MS = 1500;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A random ERC-20 delivered to the claimant via the Odos swap. */
type PayoutToken = {
  address: string;
  symbol: string;
};

/**
 * Per-chain payout entry as returned by `/api/claim` (a subset of the server's
 * `PayoutResult`). `amount` is the native currency kept by the claimant and
 * `swapAmount` the native value routed into the random token basket — both wei
 * integer strings. `tokens` are the random ERC-20s swapped into and sent to the
 * claimant (absent when the Odos swap failed and the remainder went out native).
 */
type ApiPayout = {
  chain: string;
  chainId?: number;
  amount?: string;
  swapAmount?: string;
  tokens?: PayoutToken[];
};

type ClaimResponse = {
  address?: string;
  payouts?: ApiPayout[];
};

/**
 * Chains the treasury pays out on, mirroring `PAYOUT_CHAINS` (server) in the
 * same order. Used to render the delivered token table with a stable row per
 * chain regardless of which payouts actually landed.
 */
const DELIVERED_CHAINS = [
  { slug: "optimism", chainId: 10, name: "Optimism", symbol: "ETH", icon: "/images/chains/optimism.svg" },
  { slug: "base", chainId: 8453, name: "Base", symbol: "ETH", icon: "/images/chains/base.svg" },
  { slug: "arbitrum", chainId: 42161, name: "Arbitrum", symbol: "ETH", icon: "/images/chains/arbitrum.svg" },
  { slug: "polygon", chainId: 137, name: "Polygon", symbol: "POL", icon: "/images/chains/polygon.svg" },
] as const;

type DeliveredToken = {
  chainId: number;
  address: string;
  symbol: string;
};

type DeliveredRow = {
  slug: string;
  name: string;
  symbol: string;
  icon: string;
  amount: string;
  tokens: DeliveredToken[];
  /** Whether we have payout data for this chain (false for already-claimed keys). */
  known: boolean;
};

/** Formats a wei integer to a trimmed decimal string with up to 8 fraction digits. */
function formatNative(wei: bigint): string {
  if (wei === 0n) return "0";
  const base = 10n ** 18n;
  const whole = wei / base;
  const frac = (wei % base).toString().padStart(18, "0").slice(0, 8).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function safeBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Builds one row per payout chain. `amount` is the native currency kept by the
 * claimant; the swapped remainder is delivered as the `tokens` basket and shown
 * with its own icons. For an already-claimed key (no payouts available) the row
 * shows a dash and no tokens so the layout stays intact.
 */
function buildDeliveredRows(payouts: ApiPayout[] | null): DeliveredRow[] {
  const bySlug = new Map(payouts?.map((p) => [p.chain, p]) ?? []);
  return DELIVERED_CHAINS.map((chain) => {
    const payout = bySlug.get(chain.slug);
    if (!payout) return { ...chain, amount: "—", tokens: [], known: false };
    const chainId = payout.chainId ?? chain.chainId;
    const tokens = (payout.tokens ?? []).map((t) => ({ chainId, address: t.address, symbol: t.symbol }));
    return { ...chain, amount: formatNative(safeBigInt(payout.amount)), tokens, known: true };
  });
}

export default function ClaimPage({ loaderData }: Route.ComponentProps) {
  const { key, alreadyClaimed, octocashUrl } = loaderData;
  const [stage, setStage] = React.useState<Stage>(alreadyClaimed ? "delivered" : "form");
  const [address, setAddress] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [payouts, setPayouts] = React.useState<ApiPayout[] | null>(null);

  function goToOctocash() {
    window.location.assign(octocashUrl);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!address.trim()) {
      setError("Paste an address or ENS first.");
      return;
    }
    setError(null);
    setStage("throwing");

    try {
      const [res] = await Promise.all([
        fetch("/api/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key, address }),
        }),
        sleep(THROWING_MIN_MS),
      ]);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 409) {
          // Someone else (or another tab) just claimed it — fall through to the
          // "delivered" screen anyway since the key is now in its terminal state.
          setStage("delivered");
          return;
        }
        setStage("form");
        setError(data?.error ?? `Server returned ${res.status}`);
        return;
      }
      const data = (await res.json().catch(() => null)) as ClaimResponse | null;
      setPayouts(data?.payouts ?? null);
      setStage("delivered");
    } catch (err) {
      setStage("form");
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-sky-blue-300">
      <OceanScene />

      <header className="relative z-10 flex items-center justify-center px-6 py-6">
        <Wordmark />
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-md flex-col items-center px-6 pb-20 text-center">
        <FormPanel
          address={address}
          error={error}
          octocashUrl={octocashUrl}
          onAddressChange={(v) => {
            setAddress(v);
            if (error) setError(null);
          }}
          onSubmit={handleSubmit}
        />
      </main>

      {/* Both the "throwing" and "delivered" states render inside the modal,
          each with the treasure-chest illustration spilling over the top edge. */}
      <Modal
        open={stage === "throwing" || stage === "delivered"}
        className="flex max-w-sm flex-col items-center gap-0 rounded-3xl border-2 border-violet-500 bg-white p-6 text-center"
      >
        {stage === "throwing" ? (
          <ThrowingDialog />
        ) : (
          <DeliveredDialog rows={buildDeliveredRows(payouts)} onGo={goToOctocash} />
        )}
      </Modal>
    </div>
  );
}

function Wordmark() {
  return (
    <span className="font-grotesque text-2xl font-bold lowercase tracking-tight">
      <span className="text-pink-500">octo</span>
      <span className="text-violet-500">cash</span>
    </span>
  );
}

function Hero() {
  return (
    <>
      <h1 className="font-grotesque text-4xl font-bold leading-[1.1] tracking-tight text-purple-500 sm:text-5xl">
        Catch the tokens if you can
      </h1>
      <p className="mt-4 text-lg text-violet-500 sm:text-xl">Get yours and consolidate using Octocash.</p>
      <img
        src="/images/pirate-ship.png"
        alt="A pirate monkey on a ship slinging Bitcoin, Ethereum and USDC coins"
        className="mt-8 w-full max-w-sm select-none drop-shadow-xl"
        draggable={false}
      />
    </>
  );
}

function FormPanel({
  address,
  error,
  octocashUrl,
  onAddressChange,
  onSubmit,
}: {
  address: string;
  error: string | null;
  octocashUrl: string;
  onAddressChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <>
      <Hero />

      <form onSubmit={onSubmit} className="mt-6 flex w-full max-w-sm flex-col items-center gap-6">
        <div className="flex w-full flex-col items-center gap-2">
          <Input
            value={address}
            onChange={(e) => onAddressChange(e.target.value)}
            placeholder="Paste your wallet address or Ens"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            className="h-14 rounded-full border-violet-500 bg-white text-center text-base text-violet-500 shadow-xl placeholder:text-violet-200 focus-visible:border-violet-500 focus-visible:ring-violet-500/30"
            aria-invalid={error ? true : undefined}
          />
          <p className="text-sm text-violet-500">We&apos;ll send tokens to this address</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <Button type="submit" size="lg" className="w-full">
          Receive Tokens
        </Button>
      </form>

      <hr className="mt-12 w-full max-w-sm border-t border-violet-500/20" />

      <p className="mt-8 text-sm text-violet-500">
        Don&apos;t have a wallet?{" "}
        <a href={octocashUrl} className="font-semibold text-pink-600 underline underline-offset-2 hover:text-pink-500">
          Create one
        </a>
      </p>
    </>
  );
}

/**
 * The treasure chest spilling coins, sized to overflow above the modal's top
 * edge while the lower coins rest inside the white card (matching the Figma).
 */
function Chest() {
  return (
    <img
      src="/images/treasure-chest.svg"
      alt=""
      aria-hidden="true"
      draggable={false}
      className="pointer-events-none -mt-24 w-56 select-none drop-shadow-[0_6px_4px_rgba(0,0,0,0.25)]"
    />
  );
}

function ThrowingDialog() {
  return (
    <>
      <Chest />
      <div
        className="mt-2 size-9 animate-spin rounded-full border-[3px] border-purple-500/25 border-t-purple-500"
        aria-hidden="true"
      />
      <h2 className="mt-4 font-grotesque text-2xl font-bold leading-tight text-purple-500">
        Bubbles is throwing tokens…
      </h2>
      <p className="mt-1 text-lg text-neutral-700">Sending tokens across chains</p>
    </>
  );
}

/**
 * Token icon sourced from Octocash's asset CDN
 * (`assets.octo.cash/token/{chainId}/{address}`), matching how Octocash renders
 * tokens. Falls back to the symbol's first letter when no logo exists (the CDN
 * 404s for unknown tokens).
 */
function TokenIcon({ token, className }: { token: DeliveredToken; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) {
    return (
      <span
        className={`flex items-center justify-center bg-violet-100 text-[9px] font-semibold text-violet-500 ${className ?? ""}`}
        title={token.symbol}
      >
        {token.symbol.charAt(0).toUpperCase() || "?"}
      </span>
    );
  }
  return (
    <img
      src={`https://assets.octo.cash/token/${token.chainId}/${token.address}`}
      alt={token.symbol}
      title={token.symbol}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`bg-white object-cover ${className ?? ""}`}
    />
  );
}

function DeliveredDialog({ rows, onGo }: { rows: DeliveredRow[]; onGo: () => void }) {
  return (
    <>
      <Chest />
      <h2 className="mt-2 font-grotesque text-2xl font-bold leading-tight text-purple-500">Tokens delivered</h2>
      <p className="mt-1 text-lg leading-snug text-neutral-700">Bubbles just dropped tokens in your wallet</p>

      <ul className="mt-6 w-full space-y-3">
        {rows.map((row) => (
          <li key={row.slug} className="flex items-center justify-between gap-3 border-b border-neutral-200 pb-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <img src={row.icon} alt="" aria-hidden="true" className="size-7 shrink-0" />
              <div className="flex min-w-0 flex-col text-left">
                <span className="truncate text-sm font-medium text-violet-600">{row.name}</span>
                <span className="text-xs text-neutral-500">
                  {row.amount} {row.symbol}
                </span>
              </div>
            </div>

            {row.tokens.length > 0 ? (
              <div className="flex shrink-0 flex-col items-end gap-1">
                <div className="flex -space-x-2">
                  {row.tokens.map((token) => (
                    <TokenIcon
                      key={token.address}
                      token={token}
                      className="size-6 rounded-full ring-2 ring-white"
                    />
                  ))}
                </div>
                <span className="text-[10px] text-neutral-500">+{row.tokens.length} tokens</span>
              </div>
            ) : (
              <span className="shrink-0 text-[10px] text-neutral-400">{row.known ? "native only" : ""}</span>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs text-violet-500">It&apos;s time to consolidate your tokens</p>

      <Button onClick={onGo} size="lg" className="mt-4 w-full">
        Go to Octocash
      </Button>
    </>
  );
}

function OceanScene() {
  // Decorative illustrated backdrop: a soft peach sky that melts into a
  // sky-blue ocean, layered waves at the waterline, and rising bubbles.
  const bubbles = [
    { size: 14, left: "12%", bottom: "8%", delay: "0s", duration: "7s", opacity: 0.5 },
    { size: 22, left: "82%", bottom: "14%", delay: "1.4s", duration: "9s", opacity: 0.4 },
    { size: 10, left: "28%", bottom: "20%", delay: "2.2s", duration: "6s", opacity: 0.55 },
    { size: 18, left: "68%", bottom: "5%", delay: "0.8s", duration: "8s", opacity: 0.45 },
    { size: 12, left: "48%", bottom: "10%", delay: "3s", duration: "7.5s", opacity: 0.5 },
  ];

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#ffffff_0%,#ffe1d8_26%,#ffc6d4_42%,var(--color-sky-blue-300)_60%,var(--color-sky-blue-400)_100%)]" />

      <svg className="absolute inset-x-0 top-[48%] h-48 w-full" viewBox="0 0 1440 200" preserveAspectRatio="none">
        <path
          d="M0,70 C240,130 480,20 720,56 C960,92 1200,24 1440,72 L1440,200 L0,200 Z"
          fill="var(--color-sky-blue-300)"
          opacity="0.95"
        />
        <path
          d="M0,110 C300,52 540,140 840,98 C1080,64 1260,132 1440,104 L1440,200 L0,200 Z"
          fill="var(--color-sky-blue-400)"
          opacity="0.85"
        />
        <path
          d="M0,150 C260,110 520,170 780,140 C1040,110 1240,168 1440,148 L1440,200 L0,200 Z"
          fill="var(--color-sky-blue-500)"
          opacity="0.75"
        />
      </svg>

      {bubbles.map((b, i) => (
        <span
          key={i}
          className="absolute rounded-full bg-white"
          style={{
            width: b.size,
            height: b.size,
            left: b.left,
            bottom: b.bottom,
            opacity: b.opacity,
            animation: `ocean-bubble ${b.duration} ease-in-out ${b.delay} infinite alternate`,
          }}
        />
      ))}

      <style>{`
        @keyframes ocean-bubble {
          0%   { transform: translateY(0)    scale(1);    }
          100% { transform: translateY(-26px) scale(1.08); }
        }
      `}</style>
    </div>
  );
}
