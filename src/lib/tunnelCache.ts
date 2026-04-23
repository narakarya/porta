import type { CloudflareTunnel, TunnelDnsRoute } from "./commands";

// In-memory cache for CF tunnel-related data. Shared across components so
// switching tabs or reopening Settings uses the previous snapshot instantly
// while a background refresh updates it.

let tunnelsCache: CloudflareTunnel[] = [];
let tunnelsLoaded = false;

export function getCachedTunnels(): CloudflareTunnel[] {
  return tunnelsCache;
}

export function hasTunnelCache(): boolean {
  return tunnelsLoaded;
}

export function setCachedTunnels(list: CloudflareTunnel[]) {
  tunnelsCache = list;
  tunnelsLoaded = true;
}

let dnsCache: TunnelDnsRoute[] = [];
let dnsLoaded = false;

export function getCachedDnsRoutes(): TunnelDnsRoute[] {
  return dnsCache;
}

export function hasDnsCache(): boolean {
  return dnsLoaded;
}

export function setCachedDnsRoutes(list: TunnelDnsRoute[]) {
  dnsCache = list;
  dnsLoaded = true;
}
