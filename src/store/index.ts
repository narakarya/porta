import { create } from "zustand";
import type { App, Workspace } from "../types";
import * as cmd from "../lib/commands";

interface PortaState {
  // ── Data ─────────────────────────────────────────────────────────────────
  workspaces: Workspace[];
  apps: App[];
  selectedWorkspaceId: string | null; // null = "All"

  // ── Async status ─────────────────────────────────────────────────────────
  loading: boolean;
  error: string | null;

  // ── Actions ──────────────────────────────────────────────────────────────
  load: () => Promise<void>;
  selectWorkspace: (id: string | null) => void;

  addWorkspace: (name: string, domain: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;

  addApp: (params: Parameters<typeof cmd.addApp>[0]) => Promise<void>;
  deleteApp: (id: string) => Promise<void>;
  startApp: (id: string) => Promise<void>;
  stopApp: (id: string) => Promise<void>;

  // ── Derived helpers ───────────────────────────────────────────────────────
  visibleApps: () => App[];
}

export const usePortaStore = create<PortaState>((set, get) => ({
  workspaces: [],
  apps: [],
  selectedWorkspaceId: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [workspaces, apps] = await Promise.all([
        cmd.listWorkspaces(),
        cmd.listApps(),
      ]);
      set({ workspaces, apps, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  selectWorkspace: (id) => set({ selectedWorkspaceId: id }),

  addWorkspace: async (name, domain) => {
    const workspace = await cmd.addWorkspace(name, domain);
    set((s) => ({ workspaces: [...s.workspaces, workspace] }));
  },

  deleteWorkspace: async (id) => {
    await cmd.deleteWorkspace(id);
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== id),
      apps: s.apps.filter((a) => a.workspace_id !== id),
      selectedWorkspaceId: s.selectedWorkspaceId === id ? null : s.selectedWorkspaceId,
    }));
  },

  addApp: async (params) => {
    const app = await cmd.addApp(params);
    set((s) => ({ apps: [...s.apps, app] }));
  },

  deleteApp: async (id) => {
    await cmd.deleteApp(id);
    set((s) => ({ apps: s.apps.filter((a) => a.id !== id) }));
  },

  startApp: async (id) => {
    await cmd.startApp(id);
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, status: "running" as const } : a
      ),
    }));
  },

  stopApp: async (id) => {
    await cmd.stopApp(id);
    set((s) => ({
      apps: s.apps.map((a) =>
        a.id === id ? { ...a, status: "stopped" as const, pid: null } : a
      ),
    }));
  },

  visibleApps: () => {
    const { apps, selectedWorkspaceId } = get();
    if (selectedWorkspaceId === null) return apps;
    return apps.filter((a) => a.workspace_id === selectedWorkspaceId);
  },
}));
