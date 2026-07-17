import type { StateCreator } from "zustand";
import type { Workspace } from "../../types";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";

export interface WorkspaceSlice {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  load: () => Promise<void>;
  selectWorkspace: (id: string | null) => void;
  addWorkspace: (name: string, domain: string) => Promise<void>;
  updateWorkspace: (id: string, name: string, domain: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  reorderWorkspaces: (fromIndex: number, toIndex: number) => void;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const createWorkspaceSlice: StateCreator<AllSlices, [], [], WorkspaceSlice> = (set, get) => ({
  workspaces: [],
  selectedWorkspaceId: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [workspaces, apps, services, serviceTemplates] = await Promise.all([
        cmd.listWorkspaces(),
        cmd.listApps(),
        cmd.listServices().catch(() => [] as import("../../types").Service[]),
        cmd.listServiceTemplates().catch(() => [] as import("../../types").ServiceTemplate[]),
      ]);
      const currentId = get().selectedWorkspaceId;
      const selectedWorkspaceId =
        currentId !== null
          ? currentId
          : workspaces.length > 0
          ? workspaces[0].id
          : null;
      // Initialize appStartedAt for already-running apps (survives Porta restart)
      const appStartedAt: Record<string, number> = { ...get().appStartedAt };
      for (const app of apps) {
        if ((app.status === "running" || app.status === "starting") && !appStartedAt[app.id]) {
          appStartedAt[app.id] = Date.now();
        }
      }
      set({ workspaces, apps, services, serviceTemplates, selectedWorkspaceId, loading: false, appStartedAt });

      // Populate worktree instances so nested cards render without waiting for
      // the GitBadge popover to open.
      await Promise.all(apps.map((a) => get().refreshInstances(a.id).catch(() => {})));

      if (isTauri) {
        const { MAX_LOG_LINES } = await import("../index");
        for (const app of apps) {
          if (app.status === "running" || app.status === "starting") {
            cmd.getAppLogs(app.id).then((logs) => {
              if (logs.length === 0) return;
              set((s) => ({
                appLogs: {
                  ...s.appLogs,
                  [app.id]: logs.slice(-MAX_LOG_LINES),
                },
              }));
            }).catch(() => {});
          }
        }
      }
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  selectWorkspace: (id) => set({ selectedWorkspaceId: id, extensionSidebar: null }),

  reorderWorkspaces: (fromIndex, toIndex) => {
    const list = [...get().workspaces];
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    set({ workspaces: list });
    cmd.reorderWorkspaces(list.map((w) => w.id));
  },

  addWorkspace: async (name, domain) => {
    const workspace = await cmd.addWorkspace(name, domain);
    set((s) => ({ workspaces: [...s.workspaces, workspace] }));
  },

  updateWorkspace: async (id, name, domain) => {
    const updated = await cmd.updateWorkspace(id, name, domain);
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? updated : w)),
    }));
  },

  deleteWorkspace: async (id) => {
    // Apps in this workspace must not vanish (standalone is retired). Capture
    // them, delete the workspace (backend detaches them to NULL), then move
    // them into the first remaining workspace so they stay visible + reachable.
    const affected = get().apps.filter((a) => a.workspace_id === id).map((a) => a.id);
    await cmd.deleteWorkspace(id);
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      return {
        workspaces,
        selectedWorkspaceId:
          s.selectedWorkspaceId === id ? workspaces[0]?.id ?? null : s.selectedWorkspaceId,
      };
    });
    const home = get().workspaces[0]?.id ?? null;
    if (home) {
      for (const appId of affected) await get().moveAppToWorkspace(appId, home);
    } else {
      // No workspaces left — reflect the detach in state (backend already NULLed).
      set((s) => ({
        apps: s.apps.map((a) => (affected.includes(a.id) ? { ...a, workspace_id: null } : a)),
      }));
    }
  },
});
