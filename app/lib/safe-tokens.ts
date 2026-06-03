import type { Address } from "viem";

/**
 * Curated per-chain allowlist of reputable, liquid ERC-20s used to build the
 * random payout basket. Replaces the full Odos catalog (`/token`), which is
 * dominated by illiquid/receipt/deprecated tokens that Odos can't route — the
 * cause of swap failures and the all-native fallback.
 *
 * Selection criteria: well-known, recognizable tokens (blue-chip majors,
 * canonical stablecoins, and each chain's headline assets) so claimants are
 * gifted something legitimate. Every address below was verified against Odos's
 * pricing endpoint (`GET /pricing/token/{chainId}/{address}`) — i.e. each is
 * both correct and routable from the native currency.
 *
 * The native currency is delivered separately, so this list is ERC-20s only
 * (wrapped-native is still included as a normal, highly-liquid token).
 */
export type SafeToken = { address: Address; symbol: string };

export const SAFE_TOKENS: Readonly<Record<number, readonly SafeToken[]>> = {
  // Optimism
  10: [
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },
    { address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", symbol: "USDC" },
    { address: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", symbol: "USDC.e" },
    { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", symbol: "USDT" },
    { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI" },
    { address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", symbol: "WBTC" },
    { address: "0x4200000000000000000000000000000000000042", symbol: "OP" },
    { address: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6", symbol: "LINK" },
    { address: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4", symbol: "SNX" },
    { address: "0xdC6fF44d5d932Cbd77B52E5612Ba0529DC6226F1", symbol: "WLD" },
    { address: "0x76FB31fb4af56892A25e32cFC43De717950c9278", symbol: "AAVE" },
  ],
  // Base
  8453: [
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" },
    { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", symbol: "USDbC" },
    { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI" },
    { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", symbol: "cbETH" },
    { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC" },
    { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", symbol: "AERO" },
    { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", symbol: "DEGEN" },
    { address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", symbol: "BRETT" },
    { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT" },
    { address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", symbol: "wstETH" },
  ],
  // Arbitrum
  42161: [
    { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH" },
    { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC" },
    { address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", symbol: "USDC.e" },
    { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT" },
    { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI" },
    { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", symbol: "WBTC" },
    { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", symbol: "ARB" },
    { address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", symbol: "GMX" },
    { address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", symbol: "LINK" },
    { address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0", symbol: "UNI" },
    { address: "0x5979D7b546E38E414F7E9822514be443A4800529", symbol: "wstETH" },
    { address: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8", symbol: "PENDLE" },
  ],
  // Polygon
  137: [
    { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", symbol: "WPOL" },
    { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC" },
    { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", symbol: "USDC.e" },
    { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT" },
    { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", symbol: "DAI" },
    { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", symbol: "WBTC" },
    { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH" },
    { address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", symbol: "LINK" },
    { address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", symbol: "AAVE" },
    { address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f", symbol: "UNI" },
    { address: "0xC3C7d422809852031b44ab29EEC9F1EfF2A58756", symbol: "LDO" },
    { address: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a", symbol: "SUSHI" },
  ],
} as const;
