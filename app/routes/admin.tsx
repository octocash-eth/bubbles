import { Form, redirect, useNavigation } from "react-router";
import { formatEther } from "viem";
import { ThemeToggle } from "~/components/theme";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { FundTreasury } from "~/components/wallet/fund-treasury";
import { WalletProvider } from "~/components/wallet/wallet-provider";
import { commitAdminSession, destroyAdminSession, isAdmin, verifySecret } from "~/lib/auth.server";
import { PAYOUT_CHAINS } from "~/lib/chains.server";
import { getBubblesSecret } from "~/lib/env.server";
import { createKeys, type KeyRecord, listKeys } from "~/lib/kv.server";
import { getTreasuryAddress, getTreasuryBalances } from "~/lib/treasury.server";
import { formatAddress } from "~/lib/utils";

import type { Route } from "./+types/admin";

const MAX_KEYS_PER_REQUEST = 100;

const SYMBOL_BY_CHAIN_ID = new Map(PAYOUT_CHAINS.map((p) => [p.chain.id, p.chain.nativeCurrency.symbol]));

type TreasuryChain = {
  slug: string;
  chainId: number;
  symbol: string;
  balance: string | null;
  error?: string;
};

type Treasury = {
  address: string;
  chains: TreasuryChain[];
};

async function loadTreasury(): Promise<Treasury | null> {
  const address = getTreasuryAddress();
  if (!address) return null;
  const balances = await getTreasuryBalances();
  return {
    address,
    chains: balances.map((b) => ({
      slug: b.slug,
      chainId: b.chainId,
      symbol: SYMBOL_BY_CHAIN_ID.get(b.chainId) ?? "",
      balance: b.balance === null ? null : formatEther(b.balance),
      ...("error" in b && b.error ? { error: b.error } : {}),
    })),
  };
}

export async function loader({ request }: Route.LoaderArgs) {
  if (!getBubblesSecret()) {
    return { state: "misconfigured" as const };
  }
  if (!(await isAdmin(request))) {
    return { state: "login" as const };
  }
  const [keys, treasury] = await Promise.all([listKeys(), loadTreasury()]);
  return { state: "authed" as const, keys, treasury };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "login") {
    const secret = String(form.get("secret") ?? "");
    if (!(await verifySecret(secret))) {
      return { error: "Invalid secret." };
    }
    return redirect("/admin", {
      headers: { "Set-Cookie": await commitAdminSession(request) },
    });
  }

  if (intent === "logout") {
    return redirect("/admin", {
      headers: { "Set-Cookie": await destroyAdminSession(request) },
    });
  }

  if (intent === "mint") {
    // Every mutating intent past login must be authenticated.
    if (!(await isAdmin(request))) {
      return redirect("/admin");
    }
    const rawN = Number(form.get("n") ?? 1);
    const n = Number.isInteger(rawN) ? Math.min(Math.max(rawN, 1), MAX_KEYS_PER_REQUEST) : 1;
    await createKeys(n);
    return redirect("/admin");
  }

  return { error: "Unknown action." };
}

export default function AdminPage({ loaderData, actionData }: Route.ComponentProps) {
  if (loaderData.state === "misconfigured") {
    return (
      <Shell>
        <MisconfiguredPanel />
      </Shell>
    );
  }
  if (loaderData.state === "login") {
    return (
      <Shell>
        <LoginPanel error={actionData && "error" in actionData ? actionData.error : null} />
      </Shell>
    );
  }
  return <Dashboard keys={loaderData.keys} treasury={loaderData.treasury} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <FloatingBubbles />
      <header className="relative z-10 mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2.5">
          <Bubble className="size-6" />
          <span className="font-grotesque font-semibold text-lg tracking-tight">Bubbles</span>
          <span className="rounded-full border border-border-button px-2 py-0.5 font-mono text-[0.65rem] uppercase tracking-[0.15em]">
            admin
          </span>
        </span>
        <ThemeToggle variant="ghost" />
      </header>
      <main className="relative z-10 mx-auto max-w-5xl px-6 pb-24">{children}</main>
    </div>
  );
}

function MisconfiguredPanel() {
  return (
    <div className="mx-auto mt-24 max-w-md">
      <div className="rounded-2xl border-2 border-border-button bg-card p-8 text-center shadow-button">
        <Bubble className="mx-auto size-12 opacity-60" />
        <h1 className="mt-5 font-grotesque font-bold text-2xl tracking-tight">Server misconfigured</h1>
        <p className="mt-3 text-muted-foreground text-sm">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">BUBBLES_SECRET</code> is unset, so
          the admin dashboard is disabled. Set it in the environment and reload.
        </p>
      </div>
    </div>
  );
}

function LoginPanel({ error }: { error: string | null }) {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  return (
    <div className="mx-auto mt-24 max-w-sm">
      <div className="rounded-2xl border-2 border-border-button bg-card p-8 text-center shadow-button">
        <Bubble className="mx-auto size-12" />
        <h1 className="mt-5 font-grotesque font-bold text-3xl tracking-tight">Admin access</h1>
        <p className="mt-2 text-muted-foreground text-sm">Enter the bubbles secret to continue.</p>
        <Form method="post" className="mt-8 flex flex-col gap-3 text-left">
          <input type="hidden" name="intent" value="login" />
          <Input
            name="secret"
            type="password"
            placeholder="BUBBLES_SECRET"
            autoComplete="current-password"
            autoFocus
            aria-invalid={error ? true : undefined}
            className="h-11 text-center"
          />
          {error && <p className="text-center text-destructive text-sm">{error}</p>}
          <Button type="submit" size="xl" className="mt-2" isLoading={submitting}>
            Unlock
          </Button>
        </Form>
      </div>
    </div>
  );
}

function Dashboard({ keys, treasury }: { keys: KeyRecord[]; treasury: Treasury | null }) {
  const navigation = useNavigation();
  const minting = navigation.state !== "idle" && navigation.formData?.get("intent") === "mint";
  const unused = keys.filter((k) => k.status === "unused").length;
  const claimed = keys.length - unused;

  return (
    <Shell>
      <div className="flex flex-col gap-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-grotesque font-bold text-4xl tracking-tight">Dashboard</h1>
            <p className="mt-1 text-muted-foreground text-sm">Mint claim keys and keep the treasury topped up.</p>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="logout" />
            <Button type="submit" variant="ghost">
              Log out
            </Button>
          </Form>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Total keys" value={keys.length} accent="violet" />
          <StatCard label="Unused" value={unused} accent="pink" />
          <StatCard label="Claimed" value={claimed} accent="purple" />
        </div>

        {treasury ? (
          <WalletProvider>
            <FundTreasury treasury={treasury} />
          </WalletProvider>
        ) : (
          <div className="rounded-2xl border-2 border-dashed border-border p-5 text-muted-foreground text-sm">
            Treasury unavailable —{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">BUBBLES_PRIVATE_KEY</code> is
            unset.
          </div>
        )}

        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 className="font-grotesque font-bold text-2xl tracking-tight">Keys</h2>
            <Form method="post" className="flex items-end gap-2">
              <input type="hidden" name="intent" value="mint" />
              <div className="flex flex-col gap-1">
                <label htmlFor="n" className="text-muted-foreground text-xs">
                  How many
                </label>
                <Input
                  id="n"
                  name="n"
                  type="number"
                  min={1}
                  max={MAX_KEYS_PER_REQUEST}
                  defaultValue={1}
                  className="h-10 w-24"
                />
              </div>
              <Button type="submit" isLoading={minting}>
                Mint keys
              </Button>
            </Form>
          </div>

          <KeysTable keys={keys} />
        </section>
      </div>
    </Shell>
  );
}

const ACCENTS = {
  violet: "before:bg-secondary",
  pink: "before:bg-primary",
  purple: "before:bg-purple-400",
} as const;

function StatCard({ label, value, accent }: { label: string; value: number; accent: keyof typeof ACCENTS }) {
  return (
    <div
      className={
        "relative overflow-hidden rounded-2xl border-2 border-border-button bg-card p-5 shadow-button " +
        "before:absolute before:left-0 before:top-0 before:h-full before:w-1.5 before:content-[''] " +
        ACCENTS[accent]
      }
    >
      <p className="text-muted-foreground text-xs uppercase tracking-[0.15em]">{label}</p>
      <p className="mt-2 font-grotesque font-bold text-4xl tabular-nums tracking-tight">{value}</p>
    </div>
  );
}

function KeysTable({ keys }: { keys: KeyRecord[] }) {
  if (keys.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-border py-16 text-center">
        <Bubble className="size-10 opacity-40" />
        <p className="text-muted-foreground text-sm">No keys yet. Mint some above.</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border-2 border-border-button bg-card shadow-button">
      <table className="w-full text-left text-sm">
        <thead className="border-border border-b bg-muted/40 text-muted-foreground text-xs uppercase tracking-[0.1em]">
          <tr>
            <th className="px-4 py-3 font-medium">Key</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Created</th>
            <th className="px-4 py-3 font-medium">Claimed</th>
            <th className="px-4 py-3 font-medium">Claimed by</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} className="border-border/60 border-b transition-colors last:border-0 hover:bg-muted/40">
              <td className="px-4 py-3">
                <a
                  href={`/${k.id}`}
                  className="font-mono text-button-link-foreground transition-colors hover:text-button-link-hover-foreground hover:underline"
                >
                  {k.id}
                </a>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={k.status} />
              </td>
              <td className="px-4 py-3 text-muted-foreground tabular-nums">{formatDate(k.createdAt)}</td>
              <td className="px-4 py-3 text-muted-foreground tabular-nums">{formatDate(k.claimedAt)}</td>
              <td className="px-4 py-3 font-mono text-muted-foreground">
                {k.claimedBy ? formatAddress(k.claimedBy) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: KeyRecord["status"] }) {
  const claimed = status === "claimed";
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium " +
        (claimed ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")
      }
    >
      <span
        className={"size-1.5 rounded-full " + (claimed ? "bg-muted-foreground/50" : "bg-primary")}
        aria-hidden="true"
      />
      {status}
    </span>
  );
}

function formatDate(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

/** Small gradient bubble mark used as a lightweight brand glyph. */
function Bubble({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={
        "relative inline-block rounded-full bg-gradient-to-br from-pink-300 to-purple-500 " +
        "shadow-[inset_0_-2px_4px_color-mix(in_srgb,var(--color-purple-700)_45%,transparent)] " +
        (className ?? "size-5")
      }
    >
      <span className="absolute left-[22%] top-[18%] size-[28%] rounded-full bg-white/70 blur-[0.5px]" />
    </span>
  );
}

function FloatingBubbles() {
  const bubbles = [
    { size: 240, left: "-4%", top: "8%", delay: "0s", opacity: 0.14 },
    { size: 180, left: "82%", top: "4%", delay: "1.2s", opacity: 0.16 },
    { size: 320, left: "70%", top: "70%", delay: "0.6s", opacity: 0.1 },
    { size: 140, left: "8%", top: "78%", delay: "2s", opacity: 0.14 },
  ];
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {bubbles.map((b) => (
        <span
          key={`${b.left}-${b.top}`}
          className="absolute rounded-full bg-primary blur-3xl"
          style={{
            width: b.size,
            height: b.size,
            left: b.left,
            top: b.top,
            opacity: b.opacity,
            animation: `admin-bubble-float 11s ease-in-out ${b.delay} infinite alternate`,
          }}
        />
      ))}
      <style>{`
        @keyframes admin-bubble-float {
          0%   { transform: translateY(0)     scale(1); }
          100% { transform: translateY(-24px) scale(1.06); }
        }
      `}</style>
    </div>
  );
}
