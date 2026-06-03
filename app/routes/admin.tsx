import { Form, redirect, useNavigation } from "react-router";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ThemeToggle } from "~/components/theme";
import { getBubblesSecret } from "~/lib/env.server";
import {
  commitAdminSession,
  destroyAdminSession,
  isAdmin,
  verifySecret,
} from "~/lib/auth.server";
import { createKeys, listKeys, type KeyRecord } from "~/lib/kv.server";
import { formatAddress } from "~/lib/utils";

import type { Route } from "./+types/admin";

const MAX_KEYS_PER_REQUEST = 100;

export async function loader({ request }: Route.LoaderArgs) {
  if (!getBubblesSecret()) {
    return { state: "misconfigured" as const };
  }
  if (!(await isAdmin(request))) {
    return { state: "login" as const };
  }
  return { state: "authed" as const, keys: await listKeys() };
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
    const n = Number.isInteger(rawN)
      ? Math.min(Math.max(rawN, 1), MAX_KEYS_PER_REQUEST)
      : 1;
    await createKeys(n);
    return redirect("/admin");
  }

  return { error: "Unknown action." };
}

export default function AdminPage({ loaderData, actionData }: Route.ComponentProps) {
  if (loaderData.state === "misconfigured") {
    return <Shell><MisconfiguredPanel /></Shell>;
  }
  if (loaderData.state === "login") {
    return (
      <Shell>
        <LoginPanel error={actionData && "error" in actionData ? actionData.error : null} />
      </Shell>
    );
  }
  return <Dashboard keys={loaderData.keys} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <span className="font-grotesque font-semibold text-lg tracking-tight">Bubbles admin</span>
        <ThemeToggle variant="ghost" />
      </header>
      <main className="mx-auto max-w-5xl px-6 pb-20">{children}</main>
    </div>
  );
}

function MisconfiguredPanel() {
  return (
    <div className="mx-auto mt-24 max-w-md text-center">
      <h1 className="font-grotesque font-bold text-2xl tracking-tight">Server misconfigured</h1>
      <p className="mt-3 text-muted-foreground text-sm">
        <code className="font-mono">BUBBLES_SECRET</code> is unset, so the admin dashboard is
        disabled. Set it in the environment and reload.
      </p>
    </div>
  );
}

function LoginPanel({ error }: { error: string | null }) {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  return (
    <div className="mx-auto mt-24 max-w-sm text-center">
      <h1 className="font-grotesque font-bold text-3xl tracking-tight">Admin access</h1>
      <p className="mt-3 text-muted-foreground text-sm">Enter the bubbles secret to continue.</p>
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
        {error && <p className="text-destructive text-sm">{error}</p>}
        <Button type="submit" size="xl" className="mt-2" isLoading={submitting}>
          Unlock
        </Button>
      </Form>
    </div>
  );
}

function Dashboard({ keys }: { keys: KeyRecord[] }) {
  const navigation = useNavigation();
  const minting = navigation.state !== "idle" && navigation.formData?.get("intent") === "mint";
  const unused = keys.filter((k) => k.status === "unused").length;
  const claimed = keys.length - unused;

  return (
    <Shell>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-grotesque font-bold text-3xl tracking-tight">Keys</h1>
            <p className="mt-1 text-muted-foreground text-sm">
              {keys.length} total · {unused} unused · {claimed} claimed
            </p>
          </div>
          <div className="flex items-end gap-2">
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
            <Form method="post">
              <input type="hidden" name="intent" value="logout" />
              <Button type="submit" variant="ghost">
                Log out
              </Button>
            </Form>
          </div>
        </div>

        <KeysTable keys={keys} />
      </div>
    </Shell>
  );
}

function KeysTable({ keys }: { keys: KeyRecord[] }) {
  if (keys.length === 0) {
    return (
      <div className="rounded-lg border border-border py-16 text-center text-muted-foreground text-sm">
        No keys yet. Mint some above.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-border border-b text-muted-foreground text-xs uppercase tracking-wide">
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
            <tr key={k.id} className="border-border/60 border-b last:border-0">
              <td className="px-4 py-3">
                <a href={`/${k.id}`} className="font-mono text-button-link-foreground hover:underline">
                  {k.id}
                </a>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={k.status} />
              </td>
              <td className="px-4 py-3 text-muted-foreground">{formatDate(k.createdAt)}</td>
              <td className="px-4 py-3 text-muted-foreground">{formatDate(k.claimedAt)}</td>
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
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium " +
        (claimed
          ? "bg-muted text-muted-foreground"
          : "bg-primary/10 text-primary")
      }
    >
      {status}
    </span>
  );
}

function formatDate(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}
