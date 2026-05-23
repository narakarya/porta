import type { TailscaleStatus, TailscaleServeEntry } from "./commands";

// In-memory cache for Tailscale-related fetches. Shared across components so
// the Settings tab and AppSettingsModal render the previous snapshot instantly
// on open, while a background refresh updates it.

let statusCache: TailscaleStatus | null = null;
let servesCache: TailscaleServeEntry[] = [];
let statusLoaded = false;
let servesLoaded = false;

export function getCachedTailscaleStatus(): TailscaleStatus | null {
  return statusCache;
}

export function hasTailscaleStatusCache(): boolean {
  return statusLoaded;
}

export function setCachedTailscaleStatus(status: TailscaleStatus) {
  statusCache = status;
  statusLoaded = true;
}

export function getCachedTailscaleServes(): TailscaleServeEntry[] {
  return servesCache;
}

export function hasTailscaleServesCache(): boolean {
  return servesLoaded;
}

export function setCachedTailscaleServes(list: TailscaleServeEntry[]) {
  servesCache = list;
  servesLoaded = true;
}
