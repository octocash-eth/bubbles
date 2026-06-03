import { useEffect, useState } from "react";
import { type Address, type Chain, formatEther, parseEther } from "viem";
import { useAccount, useBalance, useConnect, useDisconnect, useSendTransaction, useSwitchChain } from "wagmi";
import { injected } from "wagmi/connectors";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { formatAddress } from "~/lib/utils";
import { getWalletChain } from "~/lib/wallet";

/** How often the live treasury balances refetch, in ms. */
const BALANCE_REFETCH_INTERVAL = 12_000;

/** Trims a full-precision ether string to something readable for display. */
function trimAmount(ether: string): string {
  const n = Number(ether);
  if (!Number.isFinite(n)) return ether;
  if (n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

type TreasuryChain = {
  slug: string;
  chainId: number;
  symbol: string;
  /** Server-rendered balance (formatted ether). Live value comes from wagmi. */
  balance: string | null;
  error?: string;
};

type Treasury = {
  address: string;
  chains: TreasuryChain[];
};

type ChainStatus = "idle" | "switching" | "sending" | "sent" | "error";

type ChainState = {
  status: ChainStatus;
  txHash?: string;
  error?: string;
};

export function FundTreasury({ treasury }: { treasury: Treasury }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { address, isConnected } = useAccount();
  const { connect, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-grotesque font-bold text-2xl tracking-tight">Treasury balances</h2>
          <code className="font-mono text-muted-foreground text-sm" title={treasury.address}>
            {treasury.address}
          </code>
        </div>
        {mounted &&
          (isConnected && address ? (
            <div className="flex items-center gap-2">
              <code className="font-mono text-muted-foreground text-sm" title={address}>
                {formatAddress(address)}
              </code>
              <Button variant="ghost" size="sm" onClick={() => disconnect()}>
                Disconnect
              </Button>
            </div>
          ) : (
            <Button size="sm" isLoading={connecting} onClick={() => connect({ connector: injected() })}>
              Connect wallet
            </Button>
          ))}
      </div>

      {mounted ? (
        <div className="rounded-2xl border-2 border-border-button bg-card p-5 shadow-button">
          <p className="text-muted-foreground text-sm">
            Balances update live. Edit one and apply: raising it tops up from your wallet, lowering it refunds the
            difference to{" "}
            {address ? (
              <code className="font-mono" title={address}>
                {formatAddress(address)}
              </code>
            ) : (
              "your connected wallet"
            )}
            .
          </p>

          <ul className="mt-4 flex flex-col gap-3">
            {treasury.chains.map((chain) => (
              <ChainRow
                key={chain.chainId}
                chain={chain}
                treasuryAddress={treasury.address as Address}
                account={address}
                connected={isConnected}
              />
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-2xl border-2 border-border-button bg-card p-5 text-muted-foreground text-sm shadow-button">
          Loading wallet…
        </div>
      )}
    </section>
  );
}

function ChainRow({
  chain,
  treasuryAddress,
  account,
  connected,
}: {
  chain: TreasuryChain;
  treasuryAddress: Address;
  account: Address | undefined;
  connected: boolean;
}) {
  const viemChain = getWalletChain(chain.chainId);

  const balance = useBalance({
    address: treasuryAddress,
    chainId: chain.chainId,
    query: {
      refetchInterval: BALANCE_REFETCH_INTERVAL,
      refetchIntervalInBackground: true,
    },
  });

  const walletBalance = useBalance({
    address: account,
    chainId: chain.chainId,
    query: {
      enabled: Boolean(account),
      refetchInterval: BALANCE_REFETCH_INTERVAL,
      refetchIntervalInBackground: true,
    },
  });

  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  const [value, setValue] = useState("");
  const [edited, setEdited] = useState(false);
  const [state, setState] = useState<ChainState>({ status: "idle" });

  // Live current balance: prefer the polled wagmi value, fall back to the
  // server-rendered one until the first fetch lands.
  let currentValue: bigint | null = null;
  if (balance.data) {
    currentValue = balance.data.value;
  } else if (chain.balance !== null) {
    try {
      currentValue = parseEther(chain.balance);
    } catch {
      currentValue = null;
    }
  }
  const currentEth = currentValue !== null ? formatEther(currentValue) : null;
  const unavailable = currentValue === null;

  // While the operator hasn't typed a target, mirror the live balance so the
  // field always reflects current state (and the button stays disabled).
  useEffect(() => {
    if (!edited && currentEth !== null) setValue(currentEth);
  }, [edited, currentEth]);

  const busy = state.status === "switching" || state.status === "sending";

  let target: bigint | null = null;
  if (!unavailable) {
    try {
      const parsed = parseEther(value.trim());
      if (parsed >= 0n) target = parsed;
    } catch {
      target = null;
    }
  }
  const changed = target !== null && currentValue !== null && target !== currentValue;
  const disabled = !connected || busy || unavailable || target === null || !changed;

  async function apply() {
    if (target === null || currentValue === null) return;
    const diff = target - currentValue;
    if (diff === 0n) return;

    try {
      if (diff > 0n) {
        setState({ status: "switching" });
        await switchChainAsync({ chainId: chain.chainId });

        setState({ status: "sending" });
        const txHash = await sendTransactionAsync({
          chainId: chain.chainId,
          to: treasuryAddress,
          value: diff,
        });
        setState({ status: "sent", txHash });
      } else {
        if (!account) {
          setState({ status: "error", error: "Connect a wallet first" });
          return;
        }
        setState({ status: "sending" });
        const res = await fetch("/api/withdraw", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chainId: chain.chainId, to: account, amount: (-diff).toString() }),
        });
        const data = (await res.json().catch(() => null)) as { txHash?: string; error?: string } | null;
        if (!res.ok || !data?.txHash) {
          throw new Error(data?.error ?? "Withdraw failed");
        }
        setState({ status: "sent", txHash: data.txHash });
      }
      // Reflect the move quickly, then let polling take over, and re-arm the
      // field to track the live balance again.
      setEdited(false);
      balance.refetch();
    } catch (err) {
      setState({
        status: "error",
        error: err instanceof Error ? err.message : "transaction failed",
      });
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-28 flex-col">
        <span className="font-medium">{viemChain?.name ?? chain.slug}</span>
        {account && (
          <span className="text-muted-foreground text-xs">
            Wallet: {walletBalance.data ? `${trimAmount(formatEther(walletBalance.data.value))} ${chain.symbol}` : "…"}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => {
            setEdited(true);
            setValue(e.target.value);
          }}
          disabled={unavailable || busy}
          inputMode="decimal"
          aria-invalid={!unavailable && target === null ? true : undefined}
          className="h-9 w-40"
        />
        <span className="text-muted-foreground text-sm">{chain.symbol}</span>
      </div>
      <Button size="sm" isLoading={busy} disabled={disabled} onClick={apply}>
        Set
      </Button>
      <StatusLabel state={state} chain={viemChain} unavailable={unavailable} />
    </li>
  );
}

function StatusLabel({
  state,
  chain,
  unavailable,
}: {
  state: ChainState;
  chain: Chain | undefined;
  unavailable: boolean;
}) {
  if (unavailable) {
    return <span className="text-destructive text-sm">Balance unavailable</span>;
  }
  const explorer = chain?.blockExplorers?.default?.url;
  switch (state.status) {
    case "switching":
      return <span className="text-muted-foreground text-sm">Switching network…</span>;
    case "sending":
      return <span className="text-muted-foreground text-sm">Processing…</span>;
    case "sent":
      return explorer && state.txHash ? (
        <a
          href={`${explorer}/tx/${state.txHash}`}
          target="_blank"
          rel="noreferrer"
          className="text-button-link-foreground text-sm hover:underline"
        >
          Sent ↗
        </a>
      ) : (
        <span className="text-button-link-foreground text-sm">Sent</span>
      );
    case "error":
      return (
        <span className="text-destructive text-sm" title={state.error}>
          Failed
        </span>
      );
    default:
      return null;
  }
}
