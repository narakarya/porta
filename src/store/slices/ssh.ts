import type { StateCreator } from "zustand";
import { listen } from "../../lib/tauri-event";
import type { UnlistenFn } from "../../lib/tauri-event";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";
import { pasteIntoSession } from "../../components/ssh/SshTerminal";
import type { SshForwardRuntime, SshHost, SshPortForward, SshSnippet } from "../../lib/commands";

// Non-serializable listener handles keyed by sessionId — kept out of Zustand
// state on purpose. Registered before `ssh_connect` is invoked so backend
// events (trust-request, need-secret, status, ...) are never emitted before
// the frontend is subscribed; torn down in `disconnectSsh`.
const sessionUnlisteners = new Map<string, UnlistenFn[]>();

// Forward listeners are keyed by FORWARD id, not session id: a forward rule
// outlives any one session (it auto-starts again on the next connect), so
// tearing these down with the session would silently stop updating the row.
const forwardUnlisteners = new Map<string, UnlistenFn>();

type SshSet = Parameters<StateCreator<AllSlices, [], [], SshSlice>>[0];
type SshGet = Parameters<StateCreator<AllSlices, [], [], SshSlice>>[1];

/** Subscribe to a forward's runtime events, once. Idempotent so the repeated
 *  calls from load/add/start don't stack duplicate listeners. */
async function watchForward(id: string, set: SshSet, get: SshGet) {
  if (forwardUnlisteners.has(id)) return;
  const un = await listen(`ssh:forward:${id}`, (e) => {
    set({ forwardRuntime: { ...get().forwardRuntime, [id]: e.payload as SshForwardRuntime } });
  });
  forwardUnlisteners.set(id, un);
}

/** Drop a forward's runtime entry — absent means "not running", which is what
 *  a stopped or edited forward should read as. */
function clearRuntime(id: string, set: SshSet, get: SshGet) {
  const next = { ...get().forwardRuntime };
  delete next[id];
  set({ forwardRuntime: next });
}

/** Backend handshake steps, in the order `engine::connect` walks them. The
 *  coarse `status` can't drive a progress list — every gate before the shell
 *  reports `connecting`, so a host parked on the trust prompt and one stalled
 *  on the TCP handshake would render identically. */
export const SSH_PHASES = ["connecting", "verifying", "authenticating", "opening-shell"] as const;
export type SshPhase = (typeof SSH_PHASES)[number] | "connected" | "error";

export interface SshSession {
  id: string;
  hostId: string;
  label: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  /** Which handshake step the backend last reported (drives the connect overlay). */
  phase: SshPhase;
  /** Epoch ms the connect attempt started — feeds the overlay's elapsed timer. */
  startedAt: number;
  keyType?: string;
  /** Which host in the ProxyJump chain the current phase is about. Null for a
   *  direct connection — the backend only labels hops when there is a chain, so
   *  "Authenticating" and "Authenticating on bastion" stay distinguishable. */
  hop?: string | null;
  /** Why the session failed. Every backend failure path returns a real string
   *  (`connect: …`, `authentication failed`, `host key changed`, …); without
   *  keeping it the tab could only show a red dot over a blank terminal. */
  error?: string | null;
}

export type SshPrompt =
  | {
      sessionId: string;
      type: "trust";
      fingerprint: string;
      hostname: string;
      keyType: string;
      /** Set when the key being trusted belongs to a jump host, not the target. */
      hop?: string | null;
    }
  | { sessionId: string; type: "secret"; kind: "password" | "passphrase" }
  | { sessionId: string; type: "host-key-changed"; fingerprint: string };

export interface SshSlice {
  sshHosts: SshHost[];
  sshSessions: SshSession[];
  activeSessionId: string | null;
  sshPrompt: SshPrompt | null;
  /** Saved forward rules, keyed by host id. Loaded lazily per host. */
  sshForwards: Record<string, SshPortForward[]>;
  /** Live state per forward id, fed by `ssh:forward:{id}`. Absent = not running. */
  forwardRuntime: Record<string, SshForwardRuntime>;
  /** Saved commands, globals first, most-recently-used first within a group. */
  sshSnippets: SshSnippet[];

  loadSnippets: () => Promise<void>;
  addSnippet: (snippet: SshSnippet) => Promise<void>;
  updateSnippet: (snippet: SshSnippet) => Promise<void>;
  deleteSnippet: (id: string) => Promise<void>;
  /** Type a snippet into a session's shell, as if the user had typed it. */
  runSnippet: (snippet: SshSnippet, sessionId?: string) => Promise<void>;

  loadForwards: (hostId: string) => Promise<void>;
  addForward: (forward: SshPortForward) => Promise<void>;
  updateForward: (forward: SshPortForward) => Promise<void>;
  deleteForward: (forward: SshPortForward) => Promise<void>;
  /** Start on the host's live session; no-op with a reason if none is open. */
  startForward: (forward: SshPortForward) => Promise<void>;
  stopForward: (forward: SshPortForward) => Promise<void>;

  loadSshHosts: () => Promise<void>;
  /** Import the picked `~/.ssh/config` aliases; resolves to the rows created. */
  importSshConfigHosts: (aliases: string[], workspaceIds: string[]) => Promise<SshHost[]>;
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
  setSessionPhase: (id: string, phase: SshPhase, hop?: string | null) => void;
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
  sshForwards: {},
  forwardRuntime: {},
  sshSnippets: [],

  loadSnippets: async () => set({ sshSnippets: await cmd.sshListSnippets() }),
  addSnippet: async (snippet) => {
    await cmd.sshAddSnippet(snippet);
    // Re-read rather than append: ordering (globals first, then most-recently
    // used) is the SQL query's contract, and appending put a new global below
    // the host-scoped ones until the next load.
    await get().loadSnippets();
  },
  updateSnippet: async (snippet) => {
    await cmd.sshUpdateSnippet(snippet);
    set({ sshSnippets: get().sshSnippets.map((s) => (s.id === snippet.id ? snippet : s)) });
  },
  deleteSnippet: async (id) => {
    await cmd.sshDeleteSnippet(id);
    set({ sshSnippets: get().sshSnippets.filter((s) => s.id !== id) });
  },

  runSnippet: async (snippet, sessionId) => {
    const target = sessionId ?? get().activeSessionId;
    const session = get().sshSessions.find((s) => s.id === target);
    if (!session || session.status !== "connected") {
      throw new Error("Open a session on a host first — a snippet runs in a live shell.");
    }
    // Sent as keystrokes, not through a side channel: the output belongs in the
    // scrollback the user is looking at, and anything interactive the command
    // triggers has to reach the same PTY. The trailing newline is what makes it
    // run rather than just sit on the prompt.
    // Routed through the terminal's paste path rather than written straight to
    // the PTY: a raw write of a multi-line snippet loses every line after the
    // first as soon as line 1 prompts for anything (see pasteIntoSession).
    if (!pasteIntoSession(session.id, snippet.command)) {
      // No terminal mounted for this session. A raw write is the honest
      // fallback — it is the old behaviour, and it is correct for the
      // single-line snippets that are the common case.
      await cmd.sshWrite(
        session.id,
        Array.from(new TextEncoder().encode(`${snippet.command}\n`))
      );
    }
    // Ordering matters only for the picker's sort, so it never blocks the write.
    cmd.sshTouchSnippet(snippet.id).catch(() => {});
    set({
      sshSnippets: get().sshSnippets.map((s) =>
        s.id === snippet.id ? { ...s, last_used_at: Math.floor(Date.now() / 1000) } : s
      ),
    });
  },

  loadForwards: async (hostId) => {
    const list = await cmd.sshListForwards(hostId);
    set({ sshForwards: { ...get().sshForwards, [hostId]: list } });
    // Subscribe before anything can start them. Tauri doesn't buffer events for
    // late subscribers, and auto-start forwards fire during `ssh_connect` —
    // subscribing afterwards would miss the only "listening" event they send.
    await Promise.all(list.map((f) => watchForward(f.id, set, get)));
  },

  addForward: async (forward) => {
    const saved = await cmd.sshAddForward(forward);
    const host = saved.host_id;
    set({ sshForwards: { ...get().sshForwards, [host]: [...(get().sshForwards[host] ?? []), saved] } });
    await watchForward(saved.id, set, get);
  },

  updateForward: async (forward) => {
    await cmd.sshUpdateForward(forward);
    const host = forward.host_id;
    set({
      sshForwards: {
        ...get().sshForwards,
        [host]: (get().sshForwards[host] ?? []).map((f) => (f.id === forward.id ? forward : f)),
      },
    });
    // The backend stops a running forward on edit (its listener is bound to the
    // old port), so the row must stop claiming to be live.
    clearRuntime(forward.id, set, get);
  },

  deleteForward: async (forward) => {
    await cmd.sshDeleteForward(forward.id);
    const host = forward.host_id;
    set({
      sshForwards: {
        ...get().sshForwards,
        [host]: (get().sshForwards[host] ?? []).filter((f) => f.id !== forward.id),
      },
    });
    forwardUnlisteners.get(forward.id)?.();
    forwardUnlisteners.delete(forward.id);
    clearRuntime(forward.id, set, get);
  },

  startForward: async (forward) => {
    const session = get().sshSessions.find(
      (s) => s.hostId === forward.host_id && s.status === "connected"
    );
    if (!session) throw new Error("Connect to this host first — a forward needs a live session.");
    await watchForward(forward.id, set, get);
    // Optimistic: the bind can block on `lsof` when the port is taken, and a
    // row that doesn't react to the click reads as a dead button.
    set({
      forwardRuntime: {
        ...get().forwardRuntime,
        [forward.id]: { state: "starting", local_port: 0, active_conns: 0, capped: false, error: null },
      },
    });
    try {
      await cmd.sshStartForward(session.id, forward.id);
    } catch (e) {
      set({
        forwardRuntime: {
          ...get().forwardRuntime,
          [forward.id]: {
            state: "failed",
            local_port: forward.local_port,
            active_conns: 0,
            capped: false,
            error: e instanceof Error ? e.message : String(e),
          },
        },
      });
      throw e;
    }
  },

  stopForward: async (forward) => {
    // No session lookup: picking "the first session for this host" stopped the
    // wrong one whenever a dead session was still in the tab strip, leaving the
    // port bound while the row claimed it was stopped.
    await cmd.sshStopForward(forward.id);
  },

  loadSshHosts: async () => {
    const hosts = await cmd.sshListHosts();
    set({ sshHosts: hosts });
    // Pull each host's forwards up front so the sidebar can list them without a
    // live session, and so their listeners exist before any auto-start fires.
    // One call per host, but the vault is tens of rows, not thousands.
    await Promise.all(hosts.map((h) => get().loadForwards(h.id).catch(() => {})));
  },
  importSshConfigHosts: async (aliases, workspaceIds) => {
    const created = await cmd.sshImportConfigHosts(aliases, workspaceIds);
    // Reload rather than appending `created` — an import can skip duplicates
    // and rewrite jump links, and re-reading is the only way the list matches
    // what a fresh app start would show.
    await get().loadSshHosts();
    return created;
  },
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
              // Terminal states carry their own phase so the overlay can't keep
              // spinning on "authenticating" after an auth-failed event lands.
              phase: status === "error" || status === "connected" ? status : s.phase,
              keyType: keyType ?? s.keyType,
              // A retry/reconnect must clear the previous failure; an explicit
              // message always wins over the one already on the session.
              error: error !== undefined ? error : status === "error" ? s.error : null,
            }
          : s
      ),
    }),
  setSessionPhase: (id, phase, hop) =>
    set({ sshSessions: get().sshSessions.map((s) => (s.id === id ? { ...s, phase, hop } : s)) }),
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

    // Load + subscribe the host's forwards BEFORE connecting. The backend
    // auto-starts them inside `ssh_connect`, and Tauri drops events that have
    // no listener yet — subscribing after would leave an auto-started forward
    // permanently rendered as stopped.
    await get().loadForwards(hostId);

    // Register + await all listeners BEFORE invoking ssh_connect. Tauri events
    // are not buffered for late subscribers — the backend command blocks on
    // trust/secret oneshots and can emit trust-request/need-secret/connected
    // before we'd otherwise be listening, which would deadlock the UI.
    const unlisteners = await Promise.all([
      listen(`ssh:status:${sessionId}`, (e) => {
        const p = e.payload as { phase: string; keyType?: string; hop?: string | null };
        const map: Record<string, SshSession["status"]> = {
          connecting: "connecting",
          verifying: "connecting",
          authenticating: "connecting",
          "opening-shell": "connecting",
          connected: "connected",
          error: "error",
        };
        get().setSessionStatus(sessionId, map[p.phase] ?? "connecting", p.keyType);
        get().setSessionPhase(sessionId, (p.phase as SshPhase) ?? "connecting", p.hop ?? null);
      }),
      listen(`ssh:trust-request:${sessionId}`, (e) => {
        const p = e.payload as {
          fingerprint: string;
          hostname: string;
          key_type: string;
          hop?: string | null;
        };
        set({
          sshPrompt: {
            sessionId,
            type: "trust",
            fingerprint: p.fingerprint,
            hostname: p.hostname,
            keyType: p.key_type,
            hop: p.hop ?? null,
          },
        });
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
      listen(`ssh:exit:${sessionId}`, () => {
        // The pump ended on its own: `exit` typed in the shell, a remote
        // logout, or a drop that keepalive finally noticed. Only the terminal
        // listened for this before, so the row stayed green over a dead
        // transport — and now that forwards die with the pump, their rows would
        // have kept claiming to be listening on a port that is already free.
        get().setSessionStatus(sessionId, "disconnected");
        const lost = get().sftpForgetSession(sessionId);
        if (lost) {
          get().notify({
            kind: "error",
            message: `Unsaved changes to ${lost} were lost — the session ended before saving.`,
          });
        }
        // The forwards this session owned are told individually by the backend
        // (`stopped` on their own channel). Clearing the host's forwards here
        // would also blank ones still running on a second session to it.
      }),
      listen(`ssh:host-os:${sessionId}`, (e) => {
        const os = (e.payload as { os: string }).os;
        set({ sshHosts: get().sshHosts.map((h) => (h.id === hostId ? { ...h, detected_os: os } : h)) });
      }),
    ]);
    sessionUnlisteners.set(sessionId, unlisteners);

    get().upsertSession({
      id: sessionId,
      hostId,
      label: host.label,
      status: "connecting",
      phase: "connecting",
      startedAt: Date.now(),
    });
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
    // `ssh_close` aborts this session's forwards and emits `stopped` for each,
    // so their rows update themselves — clearing them here would also blank
    // forwards belonging to another session on the same host.
    await cmd.sshClose(sessionId);
    // The same warning the ssh:exit path raises. Dropping this return value
    // meant the deliberate close — the one the user triggers by hand — was the
    // silent one, while an involuntary drop got a message.
    const lost = get().sftpForgetSession(sessionId);
    if (lost) {
      get().notify({
        kind: "error",
        message: `Unsaved changes to ${lost} were lost when the session closed.`,
      });
    }
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
