# Bubbles

One-key, one-claim landing page that funnels visitors into [Octocash](https://octo.cash).

- `/` → redirects to `OCTOCASH_URL` (defaults to `https://octo.cash`).
- `/:key` →
  - unknown key → redirect to Octocash.
  - known + unused → renders the claim page ("Catch some tokens if you can").
  - known + already claimed → renders the "Tokens delivered" panel directly.
- `POST /api/claim` `{ key, address }` → marks the key as claimed and, best-effort, sends a proportional native payout on Optimism, Base, Arbitrum, and Polygon.
- `POST /api/keys` `{ n? }` with `Authorization: Bearer $BUBBLES_SECRET` → generates `n` keys (1–100, default 1).
- `GET /api/treasury` (public) → returns the treasury address to recharge, the number of unused keys, and the current native balance per chain.

## Treasury payouts

`BUBBLES_PRIVATE_KEY` holds the treasury EOA. One address works across all EVM
chains — fund it with native coins on each payout chain, then check the balances
via `GET /api/treasury`.

When a key is claimed, for each payout chain the claimant receives
`(balance - gasReserve) / unusedKeys`, where `unusedKeys` includes the key being
claimed (so the treasury can never overdraw). Sends are broadcast best-effort: a
failure on one chain does not roll back the claim or block the others.

## Environment variables

Copy `.env.example` to `.env` and fill in the values below.

| Variable | Required | Description |
| --- | --- | --- |
| `BUBBLES_SECRET` | Yes | Bearer token guarding `POST /api/keys`. Set to a long random string. |
| `BUBBLES_PRIVATE_KEY` | Yes | Treasury EOA private key (`0x`-hex). Funds native payouts on every payout chain. |
| `DENO_KV_PATH` | No | Path to the Deno KV store (defaults to the platform default when unset). |
| `OCTOCASH_URL` | No | Redirect target for `/` and unknown keys (defaults to `https://octo.cash`). |
| `MAINNET_RPC_URL` | No | Mainnet RPC used for ENS resolution. Falls back to viem's default public RPC. |
| `OPTIMISM_RPC_URL` | No | Optimism RPC override. Falls back to viem's default public RPC. |
| `BASE_RPC_URL` | No | Base RPC override. Falls back to viem's default public RPC. |
| `ARBITRUM_RPC_URL` | No | Arbitrum RPC override. Falls back to viem's default public RPC. |
| `POLYGON_RPC_URL` | No | Polygon RPC override. Falls back to viem's default public RPC. |

Generate a fresh treasury private key with:

```sh
echo "Private key: 0x$(openssl rand -hex 32)"
```

Fund the resulting address with native coins on each payout chain (Optimism, Base, Arbitrum, Polygon), then check balances via `GET /api/treasury`.

## Stack

Deno 2 + React Router v7 (file routes) + Deno KV + Vite + Tailwind v4 + shadcn/ui primitives copied from [octocash](../octocash). ENS resolution via plain `viem` on mainnet — no wagmi.

## Development

```sh
cp .env.example .env
# set BUBBLES_SECRET and BUBBLES_PRIVATE_KEY to real values
deno task dev
```

Mint some keys:

```sh
curl -X POST http://localhost:3000/api/keys \
  -H "Authorization: Bearer $BUBBLES_SECRET" \
  -H "content-type: application/json" \
  -d '{"n":3}'
```

Then visit `http://localhost:3000/<key>` in a browser.

## Production

```sh
deno task build
deno task start
```
