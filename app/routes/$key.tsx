import * as React from "react";
import { redirect } from "react-router";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Modal, ModalDescription, ModalHeader, ModalTitle } from "~/components/ui/modal";
import { ThemeToggle } from "~/components/theme";
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

export default function ClaimPage({ loaderData }: Route.ComponentProps) {
  const { key, alreadyClaimed, octocashUrl } = loaderData;
  const [stage, setStage] = React.useState<Stage>(alreadyClaimed ? "delivered" : "form");
  const [address, setAddress] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

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
      setStage("delivered");
    } catch (err) {
      setStage("form");
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <FloatingBubbles />

      <header className="relative z-10 mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
        <span className="font-grotesque font-semibold text-lg tracking-tight">Bubbles</span>
        <ThemeToggle variant="ghost" />
      </header>

      <main className="relative z-10 mx-auto flex max-w-xl flex-col items-center px-6 pt-12 pb-20 text-center sm:pt-20">
        {stage === "form" && (
          <FormPanel
            address={address}
            error={error}
            onAddressChange={(v) => {
              setAddress(v);
              if (error) setError(null);
            }}
            onSubmit={handleSubmit}
          />
        )}

        {alreadyClaimed && stage === "delivered" && (
          <DeliveredPanel onGo={goToOctocash} />
        )}
      </main>

      {/* When the user transitions through claim, the Modal animates the
          throwing → delivered states. When they land on an already-claimed
          key, we render DeliveredPanel inline (above) instead. */}
      {!alreadyClaimed && (
        <Modal open={stage === "throwing" || stage === "delivered"} className="text-center">
          {stage === "throwing" ? <ThrowingDialog /> : <DeliveredDialog onGo={goToOctocash} />}
        </Modal>
      )}
    </div>
  );
}

function FormPanel({
  address,
  error,
  onAddressChange,
  onSubmit,
}: {
  address: string;
  error: string | null;
  onAddressChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <>
      <h1 className="font-grotesque font-bold text-4xl tracking-tight sm:text-5xl">
        Catch some tokens if you can
      </h1>
      <p className="mt-4 max-w-md text-muted-foreground">
        We&apos;ll send you some dust that you can consolidate using Octocash.
      </p>

      <form onSubmit={onSubmit} className="mt-10 flex w-full max-w-md flex-col gap-3">
        <Input
          value={address}
          onChange={(e) => onAddressChange(e.target.value)}
          placeholder="Paste an address or ENS"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          className="h-12 text-center text-base"
          aria-invalid={error ? true : undefined}
        />
        <p className="text-muted-foreground text-xs">
          That address will receive some tokens in different chains.
        </p>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <Button type="submit" size="xl" className="mt-2">
          Receive tokens
        </Button>
      </form>
    </>
  );
}

function ThrowingDialog() {
  return (
    <>
      <ModalHeader>
        <ModalTitle className="text-2xl">Bubbles is throwing some tokens</ModalTitle>
        <ModalDescription>Sending tokens accross chains…</ModalDescription>
      </ModalHeader>
      <div className="flex items-center justify-center py-6">
        <BubbleSpinner />
      </div>
    </>
  );
}

function DeliveredDialog({ onGo }: { onGo: () => void }) {
  return (
    <>
      <ModalHeader>
        <ModalTitle className="text-2xl">Tokens delivered</ModalTitle>
        <ModalDescription>Bubbles just dropped some tokens in your wallet.</ModalDescription>
      </ModalHeader>
      <p className="text-muted-foreground text-sm">It&apos;s time to consolidate them.</p>
      <div className="flex justify-center pt-2">
        <Button onClick={onGo} size="xl">
          Go to Octocash
        </Button>
      </div>
    </>
  );
}

function DeliveredPanel({ onGo }: { onGo: () => void }) {
  return (
    <>
      <h1 className="font-grotesque font-bold text-4xl tracking-tight sm:text-5xl">Tokens delivered</h1>
      <p className="mt-4 max-w-md text-muted-foreground">
        Bubbles just dropped some tokens in your wallet.
      </p>
      <p className="mt-2 text-muted-foreground text-sm">It&apos;s time to consolidate them.</p>
      <div className="mt-10">
        <Button onClick={onGo} size="xl">
          Go to Octocash
        </Button>
      </div>
    </>
  );
}

function BubbleSpinner() {
  return (
    <div className="flex items-end gap-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block size-3 animate-bounce rounded-full bg-primary"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

function FloatingBubbles() {
  // Decorative, hidden from assistive tech. Pure CSS — no animation library.
  const bubbles = [
    { size: 220, left: "5%", top: "10%", delay: "0s", opacity: 0.18 },
    { size: 160, left: "78%", top: "18%", delay: "1.2s", opacity: 0.22 },
    { size: 280, left: "60%", top: "65%", delay: "0.6s", opacity: 0.14 },
    { size: 120, left: "12%", top: "70%", delay: "2s", opacity: 0.2 },
    { size: 90, left: "45%", top: "30%", delay: "1.6s", opacity: 0.22 },
  ];
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {bubbles.map((b, i) => (
        <span
          key={i}
          className="absolute rounded-full bg-primary blur-2xl"
          style={{
            width: b.size,
            height: b.size,
            left: b.left,
            top: b.top,
            opacity: b.opacity,
            animation: `bubble-float 9s ease-in-out ${b.delay} infinite alternate`,
          }}
        />
      ))}
      <style>{`
        @keyframes bubble-float {
          0%   { transform: translateY(0)   scale(1); }
          100% { transform: translateY(-20px) scale(1.05); }
        }
      `}</style>
    </div>
  );
}
