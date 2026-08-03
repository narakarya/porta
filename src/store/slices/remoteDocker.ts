import type { StateCreator } from "zustand";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";
import type { RemoteContainerReport } from "../../lib/commands";

/** What the Docker tab knows about one session's host. */
export interface RemoteDockerPane {
  rows: RemoteContainerReport[] | null;
  loading: boolean;
  error: string | null;
  /** Epoch ms of the last successful read, so the UI can say how old this is. */
  fetchedAt: number | null;
}

export interface RemoteDockerSlice {
  /** Keyed by session id.
   *
   *  Deliberately in the store rather than in the panel's own `useState`: the
   *  panel unmounts every time the user switches to the Terminal tab, and each
   *  mount cost a `docker ps` over SSH plus one registry round trip per
   *  distinct image. Flipping between tabs should not re-interrogate a
   *  production host. */
  remoteDocker: Record<string, RemoteDockerPane>;

  /** Read the host's containers. Cached — call with `refresh` for the user's
   *  own Refresh click, which also drops the backend's registry cache. */
  loadRemoteDocker: (sessionId: string, refresh?: boolean) => Promise<void>;
  /** Drop a dead session's pane. */
  forgetRemoteDocker: (sessionId: string) => void;
}

const empty = (): RemoteDockerPane => ({
  rows: null,
  loading: false,
  error: null,
  fetchedAt: null,
});

export const createRemoteDockerSlice: StateCreator<AllSlices, [], [], RemoteDockerSlice> = (
  set,
  get
) => ({
  remoteDocker: {},

  loadRemoteDocker: async (sessionId, refresh = false) => {
    const pane = get().remoteDocker[sessionId] ?? empty();
    // Already have it and nobody asked for fresh news: do nothing. Without this
    // the panel's mount effect would re-fetch on every tab switch.
    if (!refresh && (pane.rows !== null || pane.loading)) return;

    const patch = (p: Partial<RemoteDockerPane>) =>
      set({
        remoteDocker: {
          ...get().remoteDocker,
          [sessionId]: { ...(get().remoteDocker[sessionId] ?? empty()), ...p },
        },
      });

    patch({ loading: true, error: null });
    try {
      const rows = await cmd.sshRemoteContainers(sessionId, refresh);
      patch({ rows, loading: false, fetchedAt: Date.now() });
    } catch (e) {
      // Keep whatever rows we already had. A failed refresh should not blank a
      // list the user was reading — it should say the refresh failed.
      patch({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  forgetRemoteDocker: (sessionId) => {
    const next = { ...get().remoteDocker };
    delete next[sessionId];
    set({ remoteDocker: next });
  },
});
