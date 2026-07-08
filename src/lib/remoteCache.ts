import type { RemoteHost, RemoteRoute } from "./commands";

// In-memory cache for Porta Relay fetches. Shared across components so the
// Settings tab and TunnelQuickMenu render the previous snapshot instantly on
// open, while a background refresh updates it.

let hostsCache: RemoteHost[] = [];
let hostsLoaded = false;
let routesCache: RemoteRoute[] = [];
let routesLoaded = false;

export function getCachedRemoteHosts(): RemoteHost[] {
  return hostsCache;
}

export function hasRemoteHostsCache(): boolean {
  return hostsLoaded;
}

export function setCachedRemoteHosts(list: RemoteHost[]) {
  hostsCache = list;
  hostsLoaded = true;
}

export function getCachedRemoteRoutes(): RemoteRoute[] {
  return routesCache;
}

export function hasRemoteRoutesCache(): boolean {
  return routesLoaded;
}

export function setCachedRemoteRoutes(list: RemoteRoute[]) {
  routesCache = list;
  routesLoaded = true;
}
