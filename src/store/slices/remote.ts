import type { StateCreator } from "zustand";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";
import type { RemoteHost, RemoteRoute, RemoteHostTest } from "../../lib/commands";
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

  loadRemoteHosts: () => Promise<void>;
  addRemoteHost: (host: RemoteHost) => Promise<void>;
  updateRemoteHost: (host: RemoteHost) => Promise<void>;
  deleteRemoteHost: (id: string) => Promise<void>;
  testRemoteHost: (id: string) => Promise<RemoteHostTest>;
  loadRemoteRoutes: () => Promise<void>;
}

export const createRemoteSlice: StateCreator<AllSlices, [], [], RemoteSlice> = (set) => ({
  // Hydrate from the shared cache so the UI renders the previous snapshot
  // instantly on open, then background-refresh via load*().
  remoteHosts: hasRemoteHostsCache() ? getCachedRemoteHosts() : [],
  remoteRoutes: hasRemoteRoutesCache() ? getCachedRemoteRoutes() : [],

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
});
