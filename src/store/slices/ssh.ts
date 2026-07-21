import type { StateCreator } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";
import type { SshHost } from "../../lib/commands";

// Non-serializable listener handles keyed by sessionId — kept out of Zustand
// state on purpose. Registered before `ssh_connect` is invoked so backend
// events (trust-request, need-secret, status, ...) are never emitted before
// the frontend is subscribed; torn down in `disconnectSsh`.
const sessionUnlisteners = new Map<string, UnlistenFn[]>();

export interface SshSession {
  id: string;
  hostId: string;
  label: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  keyType?: string;
  /** Why the session failed. Every backend failure path returns a real string
   *  (`connect: …`, `authentication failed`, `host key changed`, …); without
   *  keeping it the tab could only show a red dot over a blank terminal. */
  error?: string | null;
}

export type SshPrompt =
  | { sessionId: string; type: "trust"; fingerprint: string; hostname: string; keyType: string }
  | { sessionId: string; type: "secret"; kind: "password" | "passphrase" }
  | { sessionId: string; type: "host-key-changed"; fingerprint: string };

export interface SshSlice {
  sshHosts: SshHost[];
  sshSessions: SshSession[];
  activeSessionId: string | null;
  sshPrompt: SshPrompt | null;

  loadSshHosts: () => Promise<void>;
  addSshHost: (host: SshHost) => Promise<void>;
  updateSshHost: (host: SshHost) => Promise<void>;
  deleteSshHost: (id: string) => Promise<void>;
  connectSsh: (hostId: string) => Promise<void>;
  /** Focus the host's most recent live session if one exists, else open a new one. */
  connectOrFocusSsh: (hostId: string) => Promise<void>;
  /** Retry a failed session: drop the dead one, then reconnect its host. */
  retrySsh: (sessionId: string) => Promise<void>;
  disconnectSsh: (sessionId: string) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  upsertSession: (s: SshSession) => void;
  setSessionStatus: (id: string, status: SshSession["status"], keyType?: string, error?: string | null) => void;
  answerTrust: () => Promise<void>;
  answerSecret: (value: string, remember: boolean) => Promise<void>;
  dismissPrompt: () => void;
  cancelPrompt: () => Promise<void>;
}

export const createSshSlice: StateCreator<AllSlices, [], [], SshSlice> = (set, get) => ({
  sshHosts: [],
  sshSessions: [],
  activeSessionId: null,
  sshPrompt: null,

  loadSshHosts: async () => set({ sshHosts: await cmd.sshListHosts() }),
  addSshHost: async (host) => {
    const saved = await cmd.sshAddHost(host);
    set({ sshHosts: [...get().sshHosts, saved] });
  },
  updateSshHost: async (host) => {
    await cmd.sshUpdateHost(host);
    set({ sshHosts: get().sshHosts.map((h) => (h.id === host.id ? host : h)) });
  },
  deleteSshHost: async (id) => {
    await cmd.sshDeleteHost(id);
    set({ sshHosts: get().sshHosts.filter((h) => h.id !== id) });
  },

  upsertSession: (s) => set({ sshSessions: [...get().sshSessions.filter((x) => x.id !== s.id), s] }),
  setSessionStatus: (id, status, keyType, error) =>
    set({
      sshSessions: get().sshSessions.map((s) =>
        s.id === id
          ? {
              ...s,
              status,
              keyType: keyType ?? s.keyType,
              // A retry/reconnect must clear the previous failure; an explicit
              // message always wins over the one already on the session.
              error: error !== undefined ? error : status === "error" ? s.error : null,
            }
          : s
      ),
    }),
  setActiveSession: (id) => set({ activeSessionId: id }),

  connectOrFocusSsh: async (hostId) => {
    const live = get().sshSessions.filter((s) => s.hostId === hostId && s.status !== "disconnected");
    if (live.length > 0) {
      set({ activeSessionId: live[live.length - 1].id });
      return;
    }
    await get().connectSsh(hostId);
  },

  // Retry used to call `connectSsh` straight from the error card, which mints
  // a fresh sessionId and upserts it as an ADDITIONAL session — the failed one
  // stayed in the tab strip, so every retry left another dead red tab behind.
  // Tear the dead session down first (also unregisters its listeners).
  retrySsh: async (sessionId) => {
    const dead = get().sshSessions.find((s) => s.id === sessionId);
    if (!dead) return;
    await get().disconnectSsh(sessionId);
    await get().connectSsh(dead.hostId);
  },

  connectSsh: async (hostId) => {
    const host = get().sshHosts.find((h) => h.id === hostId);
    if (!host) return;
    const sessionId = crypto.randomUUID();

    // Register + await all listeners BEFORE invoking ssh_connect. Tauri events
    // are not buffered for late subscribers — the backend command blocks on
    // trust/secret oneshots and can emit trust-request/need-secret/connected
    // before we'd otherwise be listening, which would deadlock the UI.
    const unlisteners = await Promise.all([
      listen(`ssh:status:${sessionId}`, (e) => {
        const p = e.payload as { phase: string; keyType?: string };
        const map: Record<string, SshSession["status"]> = {
          connecting: "connecting",
          authenticating: "connecting",
          connected: "connected",
          error: "error",
        };
        get().setSessionStatus(sessionId, map[p.phase] ?? "connecting", p.keyType);
      }),
      listen(`ssh:trust-request:${sessionId}`, (e) => {
        const p = e.payload as { fingerprint: string; hostname: string; key_type: string };
        set({ sshPrompt: { sessionId, type: "trust", fingerprint: p.fingerprint, hostname: p.hostname, keyType: p.key_type } });
      }),
      listen(`ssh:need-secret:${sessionId}`, (e) => {
        const p = e.payload as { kind: "password" | "passphrase" };
        set({ sshPrompt: { sessionId, type: "secret", kind: p.kind } });
      }),
      listen(`ssh:host-key-changed:${sessionId}`, (e) => {
        const p = e.payload as { fingerprint: string };
        set({ sshPrompt: { sessionId, type: "host-key-changed", fingerprint: p.fingerprint } });
        get().setSessionStatus(sessionId, "error", undefined, `Host key changed (${p.fingerprint})`);
      }),
      listen(`ssh:auth-failed:${sessionId}`, (e) => {
        const msg = (e.payload as { message?: string } | null)?.message;
        get().setSessionStatus(sessionId, "error", undefined, msg || "Authentication failed");
      }),
      listen(`ssh:host-os:${sessionId}`, (e) => {
        const os = (e.payload as { os: string }).os;
        set({ sshHosts: get().sshHosts.map((h) => (h.id === hostId ? { ...h, detected_os: os } : h)) });
      }),
    ]);
    sessionUnlisteners.set(sessionId, unlisteners);

    get().upsertSession({ id: sessionId, hostId, label: host.label, status: "connecting" });
    set({ activeSessionId: sessionId });

    try {
      await cmd.sshConnect(hostId, sessionId);
    } catch (e) {
      // `ssh_connect` returns a real reason on every failure path ("connect:
      // Connection refused", "authentication failed", "host key not trusted",
      // …). Discarding it left the tab as a red dot over a blank terminal with
      // nothing to act on — keep it and let the session tab render it.
      const msg = e instanceof Error ? e.message : String(e);
      get().setSessionStatus(sessionId, "error", undefined, msg || "Connection failed");
    }
  },

  disconnectSsh: async (sessionId) => {
    await cmd.sshClose(sessionId);
    sessionUnlisteners.get(sessionId)?.forEach((unlisten) => unlisten());
    sessionUnlisteners.delete(sessionId);
    set({ sshSessions: get().sshSessions.filter((s) => s.id !== sessionId) });
    if (get().activeSessionId === sessionId) set({ activeSessionId: get().sshSessions[0]?.id ?? null });
    if (get().sshPrompt?.sessionId === sessionId) set({ sshPrompt: null });
  },

  answerTrust: async () => {
    const p = get().sshPrompt;
    if (p?.type === "trust") {
      await cmd.sshTrustHost(p.sessionId);
      set({ sshPrompt: null });
    }
  },
  answerSecret: async (value, remember) => {
    const p = get().sshPrompt;
    if (p?.type === "secret") {
      await cmd.sshProvideSecret(p.sessionId, value, remember);
      set({ sshPrompt: null });
    }
  },
  dismissPrompt: () => set({ sshPrompt: null }),

  // Cancelling a trust/secret prompt must abort the parked `connect()` call
  // on the backend, not just clear frontend state — connect() blocks on a
  // oneshot awaiting this answer, and dismissing the prompt without closing
  // the session would leak the SSH transport (tab stuck "connecting"
  // forever). disconnectSsh -> ssh_close drops the backend Session, which
  // drops the oneshot sender, which makes the parked `rx.await` error and
  // unwinds connect(). host-key-changed has nothing parked (connect()
  // already returned Err), so just clear the prompt there.
  cancelPrompt: async () => {
    const p = get().sshPrompt;
    if (!p) return;
    if (p.type === "trust" || p.type === "secret") {
      await get().disconnectSsh(p.sessionId);
    } else {
      set({ sshPrompt: null });
    }
  },
});
