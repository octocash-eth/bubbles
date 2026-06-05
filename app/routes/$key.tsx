import * as React from "react";
import { redirect } from "react-router";

import { Button } from "~/components/ui/button";
import { Modal } from "~/components/ui/modal";
import { getOctocashUrl } from "~/lib/env.server";
import { getKey } from "~/lib/kv.server";
import { getMetaMaskInstallUrl } from "~/lib/utils";

import type { Route } from "./+types/$key";

// Preload the treasure-chest illustration so the throwing/delivered modal's
// `<Chest />` paints instantly when a claim is thrown, rather than fetching the
// SVG mid-animation.
export const links: Route.LinksFunction = () => [
  { rel: "preload", href: "/images/treasure-chest.svg", as: "image" },
];

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

/**
 * Resolves the platform-appropriate MetaMask download link. Starts with the
 * universal landing page so SSR and the first client render agree (avoiding a
 * hydration mismatch), then narrows to the Play Store / App Store / Firefox
 * add-on / Chrome Web Store once `navigator.userAgent` is available.
 */
function useMetaMaskInstallUrl(): string {
  const [url, setUrl] = React.useState(() => getMetaMaskInstallUrl());
  React.useEffect(() => {
    setUrl(getMetaMaskInstallUrl(navigator.userAgent));
  }, []);
  return url;
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
  const metamaskUrl = useMetaMaskInstallUrl();

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

  const onAddressChange = (v: string) => {
    setAddress(v);
    if (error) setError(null);
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-white">
      <Backdrop />

      <header className="relative z-10 flex items-center justify-center px-6 py-6 sm:px-10 sm:py-8 lg:justify-start lg:px-24">
        <Wordmark />
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col px-6 pb-8 sm:px-10 sm:pb-16 lg:px-24 lg:pb-24">
        {/* Desktop: left-aligned hero with an inline "Claim" pill (Figma desktop). */}
        <DesktopPanel
          address={address}
          error={error}
          metamaskUrl={metamaskUrl}
          onAddressChange={onAddressChange}
          onSubmit={handleSubmit}
        />

        {/* Mobile: centered hero, pirate illustration, stacked CTA (Figma mobile). */}
        <MobilePanel
          address={address}
          error={error}
          metamaskUrl={metamaskUrl}
          onAddressChange={onAddressChange}
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
    <span className="font-grotesque text-2xl font-bold lowercase tracking-tight sm:text-3xl">
      <span className="text-pink-500">octo</span>
      <span className="text-violet-500">cash</span>
    </span>
  );
}

type PanelProps = {
  address: string;
  error: string | null;
  metamaskUrl: string;
  onAddressChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
};

/**
 * Desktop hero (Figma "Octo Landing Page Desktop"): a left-aligned headline over
 * the full-bleed pirate backdrop, with the address field and "Claim" button
 * combined into a single rounded pill. Hidden below the `lg` breakpoint.
 */
function DesktopPanel({ address, error, metamaskUrl, onAddressChange, onSubmit }: PanelProps) {
  return (
    <div className="hidden flex-1 flex-col justify-center lg:flex">
      <div className="max-w-[520px]">
        <h1 className="font-grotesque text-[clamp(2.25rem,4.4vw,68px)] font-bold leading-[1.1] tracking-[0.01em]">
          <span className="text-violet-500">You found some tokens</span>{" "}
          <span className="text-purple-500">Bubbles dropped</span>
        </h1>
        <p className="mt-4 max-w-[460px] font-grotesque text-[clamp(1.25rem,2vw,32px)] leading-[1.15] tracking-[0.01em] text-violet-500">
          Claim them and consolidate with Octocash
        </p>
      </div>

      <form onSubmit={onSubmit} className="mt-10 max-w-[560px]">
        <div className="flex items-center gap-4 rounded-full border border-violet-500 bg-white py-[20px] pr-[20px] pl-[30px] shadow-[0px_4px_16px_0px_rgba(0,0,0,0.25)] focus-within:ring-2 focus-within:ring-violet-500/30">
          <input
            value={address}
            onChange={(e) => onAddressChange(e.target.value)}
            placeholder="Paste your address or ENS name"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            aria-label="Wallet address or ENS"
            aria-invalid={error ? true : undefined}
            className="min-w-0 flex-1 bg-transparent font-grotesque text-2xl text-violet-500 outline-none placeholder:text-violet-200"
          />
          <button
            type="submit"
            className="shrink-0 rounded-full border border-pink-200 bg-white px-9 py-3 font-medium text-pink-400 transition-colors hover:border-pink-400 hover:text-pink-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-300/50"
          >
            Claim
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 pl-2 text-sm">
          {error ? (
            <p className="text-destructive">{error}</p>
          ) : (
            <p className="text-violet-500/70">We&apos;ll send tokens to this address</p>
          )}
          <p className="text-violet-500/70">
            Don&apos;t have a wallet?{" "}
            <a
              href={metamaskUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-pink-600 underline underline-offset-2 hover:text-pink-500"
            >
              Create one
            </a>
          </p>
        </div>
      </form>
    </div>
  );
}

/**
 * Mobile hero (Figma "Bubbles" mobile): centered headline, the pirate
 * illustration, then a stacked address field and full-width "Receive Tokens"
 * button, a divider, and the "Create one" link. Shown below the `lg` breakpoint.
 */
function MobilePanel({ address, error, metamaskUrl, onAddressChange, onSubmit }: PanelProps) {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center text-center lg:hidden">
      <h1 className="font-grotesque text-4xl font-bold leading-[1.2] tracking-[0.01em]">
        <span className="text-violet-500">You found some tokens</span>{" "}
        <span className="text-purple-500">Bubbles dropped</span>
      </h1>
      <p className="mt-2 text-xl leading-relaxed text-violet-500">Claim them and consolidate with Octocash</p>

      {/* The pirate ship and bubble cluster are baked into the full-bleed backdrop
          and sit around the vertical middle. This flexible gap reserves that band so
          the form drops into the water below instead of overlapping the ship. */}
      <div aria-hidden="true" className="min-h-60 flex-1" />

      <form onSubmit={onSubmit} className="flex w-full flex-col items-center gap-6">
        <div className="flex w-full flex-col items-center gap-2">
          <input
            value={address}
            onChange={(e) => onAddressChange(e.target.value)}
            placeholder="Paste your address or ENS name"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            aria-label="Wallet address or ENS"
            aria-invalid={error ? true : undefined}
            className="h-14 w-full rounded-full border border-violet-500 bg-white px-5 text-center text-base text-violet-500 shadow-xl outline-none placeholder:text-violet-200 focus-visible:ring-2 focus-visible:ring-violet-500/30"
          />
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <p className="text-sm text-violet-500">We&apos;ll send tokens to this address</p>
          )}
        </div>

        <button
          type="submit"
          className="h-12 w-full rounded-full border-2 border-violet-500 bg-white font-medium text-pink-500 shadow-[3px_3px_0_0_var(--color-violet-500)] transition-colors hover:bg-pink-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 active:shadow-[inset_0_4px_4px_0_color-mix(in_srgb,var(--color-violet-500)_30%,transparent)]"
        >
          Receive Tokens
        </button>
      </form>

      <hr className="mt-10 w-full border-t border-violet-500/20" />

      <p className="mt-6 text-sm text-violet-500">
        Don&apos;t have a wallet?{" "}
        <a
          href={metamaskUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-pink-600 underline underline-offset-2 hover:text-pink-500"
        >
          Create one
        </a>
      </p>
    </div>
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

/**
 * Full-bleed Figma "Bubbles" backdrop (gradient sky, bubble cluster and waves
 * are all baked into the SVGs). The portrait `bg.svg` is the mobile artwork; the
 * landscape `bg-big.svg` swaps in at the `lg` breakpoint — the same point the
 * desktop hero appears — so the wide layout never gets the cropped portrait
 * backdrop. A left-to-transparent white scrim keeps the desktop hero copy
 * legible over the bubbles.
 */
function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <picture className="contents">
        <source srcSet="/images/bg-big.svg" media="(min-width: 1024px)" />
        <img
          src="/images/bg.svg"
          alt=""
          draggable={false}
          className="size-full select-none object-cover object-center"
        />
      </picture>
      <div className="absolute inset-0 hidden bg-linear-to-r from-white/70 via-white/25 to-transparent lg:block" />
    </div>
  );
}
