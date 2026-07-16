import type { StateCreator } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";
import type { SshHost } from "../../lib/commands";

export interface SshSession {
  id: string;
  hostId: string;
  label: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  keyType?: string;
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
  disconnectSsh: (sessionId: string) => Promise<void>;
  setActiveSession: (id: string | null) => void;
  upsertSession: (s: SshSession) => void;
  setSessionStatus: (id: string, status: SshSession["status"], keyType?: string) => void;
  answerTrust: () => Promise<void>;
  answerSecret: (value: string, remember: boolean) => Promise<void>;
  dismissPrompt: () => void;
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
  setSessionStatus: (id, status, keyType) =>
    set({
      sshSessions: get().sshSessions.map((s) => (s.id === id ? { ...s, status, keyType: keyType ?? s.keyType } : s)),
    }),
  setActiveSession: (id) => set({ activeSessionId: id }),

  connectSsh: async (hostId) => {
    const host = get().sshHosts.find((h) => h.id === hostId);
    if (!host) return;
    const sessionId = await cmd.sshConnect(hostId);
    get().upsertSession({ id: sessionId, hostId, label: host.label, status: "connecting" });
    set({ activeSessionId: sessionId });

    // Per-session prompt + status listeners. Data/exit are handled inside SshTerminal (Task 10).
    listen(`ssh:status:${sessionId}`, (e) => {
      const p = e.payload as { phase: string; keyType?: string };
      const map: Record<string, SshSession["status"]> = {
        connecting: "connecting",
        authenticating: "connecting",
        connected: "connected",
        error: "error",
      };
      get().setSessionStatus(sessionId, map[p.phase] ?? "connecting", p.keyType);
    });
    listen(`ssh:trust-request:${sessionId}`, (e) => {
      const p = e.payload as { fingerprint: string; hostname: string; key_type: string };
      set({ sshPrompt: { sessionId, type: "trust", fingerprint: p.fingerprint, hostname: p.hostname, keyType: p.key_type } });
    });
    listen(`ssh:need-secret:${sessionId}`, (e) => {
      const p = e.payload as { kind: "password" | "passphrase" };
      set({ sshPrompt: { sessionId, type: "secret", kind: p.kind } });
    });
    listen(`ssh:host-key-changed:${sessionId}`, (e) => {
      const p = e.payload as { fingerprint: string };
      set({ sshPrompt: { sessionId, type: "host-key-changed", fingerprint: p.fingerprint } });
      get().setSessionStatus(sessionId, "error");
    });
    listen(`ssh:auth-failed:${sessionId}`, () => get().setSessionStatus(sessionId, "error"));
  },

  disconnectSsh: async (sessionId) => {
    await cmd.sshClose(sessionId);
    set({ sshSessions: get().sshSessions.filter((s) => s.id !== sessionId) });
    if (get().activeSessionId === sessionId) set({ activeSessionId: get().sshSessions[0]?.id ?? null });
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
});
