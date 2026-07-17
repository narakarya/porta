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
      const browserLogs = isTauri ? get().appLogs : Object.fromEntries(
        apps.filter((app) => app.status === "running").map((app) => [app.id, [
          "2026-07-15 10:42:08.117 [info] GET /api/teachers/profile → 200 in 24ms",
          "2026-07-15 10:42:08.231 [debug] QUERY OK source=\"teachers\" db=1.3ms queue=0.1ms idle=512.4ms\n        SELECT t0.\"id\", t0.\"name\", t0.\"email\", t0.\"role\", t0.\"inserted_at\", t0.\"updated_at\" FROM \"teachers\" AS t0 WHERE (t0.\"id\" = $1) AND (t0.\"active\" = TRUE)",
          "2026-07-15 10:42:09.004 [info] User context set user_id=88",
          "2026-07-15 10:42:09.118 [info] POST /api/teachers/profile → 204 in 18ms",
          "2026-07-15 10:42:10.552 [warn] Slow query detected: 812ms SELECT count(*) FROM assignments",
          "2026-07-15 10:42:11.003 [info] Cache populated key=teacher-profile:88 ttl=300s",
          "2026-07-15 10:42:11.561 [error] ** (Ecto.InvalidChangesetError) invalid changeset",
          "  Changeset: #Ecto.Changeset<action: :validate, changes: %{}, errors: [",
          "    role: {\"is invalid\", [validation: :inclusion, enum: ~w(teacher admin staff)a]}],",
          "    data: #NarakaryaAcademic.User<>, valid?: false>",
          "  (ecto 3.12.4) lib/ecto/changeset.ex:3452: Ecto.Changeset.apply_action!/2",
          "  (narakarya_academic 0.1.0) lib/narakarya_academic/users.ex:128: update_user/2",
          "  (narakarya_academic_web 0.1.0) lib/controllers/user_controller.ex:76: update/2",
          "  (narakarya_academic_web 0.1.0) lib/narakarya_academic_web/endpoint.ex:1: NarakaryaAcademicWeb.Endpoint.call/2",
          "  (narakarya_academic 0.1.0) lib/plug/debugger.ex:136: NarakaryaAcademicWeb.Endpoint.call/2",
          "  (narakarya_academic_web 0.1.0) lib/narakarya_academic_web/endpoint.ex:1: NarakaryaAcademicWeb.Endpoint.call/2",
          "  (phoenix 1.7.19) lib/phoenix/endpoint/sync_code_reload_plug.ex:29: call/4",
          "2026-07-15 10:42:11.563 [info] POST /api/teachers/profile → 422 in 14ms",
          "2026-07-15 10:42:12.004 [debug] Parameters: name=Ade email=ade@uq.test role=supervisor",
          "2026-07-15 10:42:12.221 [info] GET /health → 200 in 3ms",
          "2026-07-15 10:42:13.221 [info] Phoenix live reload recompiled 2 files in 112ms",
          "2026-07-15 10:42:13.118 [info] Metrics: req_count=1245 mem=312MB cpu=8%",
          "2026-07-15 10:42:14.051 [success] Backup completed: 14.3MB uploaded in 2.1s",
          "2026-07-15 10:42:15.231 [info] GET /api/teachers/profile → 200 in 19ms",
        ]]),
      );
      set({ workspaces, apps, services, serviceTemplates, selectedWorkspaceId, loading: false, appStartedAt, appLogs: browserLogs });

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
    await cmd.deleteWorkspace(id);
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== id),
      apps: s.apps.filter((a) => a.workspace_id !== id),
      selectedWorkspaceId: s.selectedWorkspaceId === id ? null : s.selectedWorkspaceId,
    }));
  },
});
