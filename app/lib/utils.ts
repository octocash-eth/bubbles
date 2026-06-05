import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Helper function to format addresses as 0xaaaa..bbbb
export function formatAddress(address: string): string {
  if (!address || address.length < 10) return address;
  const prefix = address.slice(0, 6);
  const suffix = address.slice(-4);
  return `${prefix}..${suffix}`;
}

export async function tryCatch<T>(fn: Promise<T>): Promise<[T | null, Error | null]> {
  try {
    const value = await fn;
    return [value, null];
  } catch (err) {
    return [null, err as Error];
  }
}

/** Platform-specific MetaMask download destinations. */
const METAMASK_INSTALL_URLS = {
  /** Generic landing page that itself forwards to the right store/extension. */
  default: "https://metamask.io/download/",
  android: "https://play.google.com/store/apps/details?id=io.metamask",
  ios: "https://apps.apple.com/app/metamask/id1438144202",
  firefox: "https://addons.mozilla.org/firefox/addon/ether-metamask/",
  chromium: "https://chromewebstore.google.com/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn",
} as const;

/**
 * Picks the best MetaMask install link for the visitor's platform from their
 * user-agent string. Mobile platforms win first (on iOS every browser is
 * WebKit, so Firefox/Chrome there still go to the App Store), then desktop
 * Firefox gets the add-on, and everything else (Chrome/Edge/Brave/Opera…)
 * gets the Chrome Web Store. Falls back to the universal landing page when the
 * user agent is unknown (e.g. during SSR).
 */
export function getMetaMaskInstallUrl(userAgent?: string | null): string {
  if (!userAgent) return METAMASK_INSTALL_URLS.default;
  const ua = userAgent.toLowerCase();

  if (/android/.test(ua)) return METAMASK_INSTALL_URLS.android;
  if (/iphone|ipad|ipod/.test(ua)) return METAMASK_INSTALL_URLS.ios;
  // Desktop Firefox (and forks like LibreWolf). `fxios` was handled by the iOS
  // check above; `seamonkey` shares Gecko, so include it.
  if (/firefox|fxios|seamonkey/.test(ua)) return METAMASK_INSTALL_URLS.firefox;
  return METAMASK_INSTALL_URLS.chromium;
}
