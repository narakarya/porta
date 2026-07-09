import type { StateCreator } from "zustand";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";
import type { RemoteHost, RemoteRoute, RemoteHostTest, WgStatus, DiffReport } from "../../lib/commands";
import {
  getCachedRemoteHosts,
  hasRemoteHostsCache,
  setCachedRemoteHosts,
  getCachedRemoteRoutes,
  hasRemoteRoutesCache,
  setCachedRemoteRoutes,
} from "../../lib/remoteCache";

export interface RemoteSlice {
  remoteHosts: RemoteHost[];
  remoteRoutes: RemoteRoute[];
  wgStatuses: Record<string, WgStatus>;

  loadRemoteHosts: () => Promise<void>;
  addRemoteHost: (host: RemoteHost) => Promise<void>;
  updateRemoteHost: (host: RemoteHost) => Promise<void>;
  deleteRemoteHost: (id: string) => Promise<void>;
  testRemoteHost: (id: string) => Promise<RemoteHostTest>;
  loadRemoteRoutes: () => Promise<void>;
  loadWgStatus: (hostId: string) => Promise<void>;
  loadAllWgStatuses: () => Promise<void>;

  remoteDiffs: Record<string, DiffReport>;
  loadRemoteDiff: (hostId: string) => Promise<DiffReport>;
  pushRemoteHost: (hostId: string) => Promise<void>;
  removeForeign: (hostId: string, publicHost: string) => Promise<void>;
}

export const createRemoteSlice: StateCreator<AllSlices, [], [], RemoteSlice> = (set, get) => ({
  // Hydrate from the shared cache so the UI renders the previous snapshot
  // instantly on open, then background-refresh via load*().
  remoteHosts: hasRemoteHostsCache() ? getCachedRemoteHosts() : [],
  remoteRoutes: hasRemoteRoutesCache() ? getCachedRemoteRoutes() : [],
  wgStatuses: {},

  loadRemoteHosts: async () => {
    const remoteHosts = await cmd.listRemoteHosts();
    setCachedRemoteHosts(remoteHosts);
    set({ remoteHosts });
  },

  addRemoteHost: async (host) => {
    await cmd.addRemoteHost(host);
    const remoteHosts = await cmd.listRemoteHosts();
    setCachedRemoteHosts(remoteHosts);
    set({ remoteHosts });
  },

  updateRemoteHost: async (host) => {
    await cmd.updateRemoteHost(host);
    const remoteHosts = await cmd.listRemoteHosts();
    setCachedRemoteHosts(remoteHosts);
    set({ remoteHosts });
  },

  deleteRemoteHost: async (id) => {
    await cmd.deleteRemoteHost(id);
    const remoteHosts = await cmd.listRemoteHosts();
    setCachedRemoteHosts(remoteHosts);
    set({ remoteHosts });
  },

  testRemoteHost: (id) => cmd.testRemoteHost(id),

  loadRemoteRoutes: async () => {
    const remoteRoutes = await cmd.listRemoteRoutes();
    setCachedRemoteRoutes(remoteRoutes);
    set({ remoteRoutes });
  },

  loadWgStatus: async (hostId) => {
    try {
      const st = await cmd.wgStatus(hostId);
      set((s) => ({ wgStatuses: { ...s.wgStatuses, [hostId]: st } }));
    } catch {
      // Non-fatal — leave the previous status in place.
    }
  },

  loadAllWgStatuses: async () => {
    const hosts = get().remoteHosts;
    await Promise.all(hosts.map((h) => get().loadWgStatus(h.id)));
  },

  remoteDiffs: {},

  loadRemoteDiff: async (hostId) => {
    const report = await cmd.remoteDiff(hostId);
    set((s) => ({ remoteDiffs: { ...s.remoteDiffs, [hostId]: report } }));
    return report;
  },

  pushRemoteHost: async (hostId) => {
    await cmd.remotePushHost(hostId);
    await get().loadRemoteDiff(hostId);
  },

  removeForeign: async (hostId, publicHost) => {
    await cmd.remoteRemoveForeign(hostId, publicHost);
    await get().loadRemoteDiff(hostId);
  },
});
