import { describe, it, expect, beforeEach } from "vitest";
import { usePortaStore } from "../index";
import type { SshSession } from "./ssh";

const session = (over: Partial<SshSession> & Pick<SshSession, "id">): SshSession => ({
  hostId: "h1",
  label: "NAS",
  status: "connecting",
  phase: "connecting",
  startedAt: 0,
  ...over,
});

/**
 * Regression cover for the "red dot, blank terminal, no reason" bug: every
 * backend failure path returns a real message, and the session must carry it.
 */
describe("ssh session status", () => {
  beforeEach(() => {
    usePortaStore.setState({
      sshSessions: [session({ id: "s1" })],
    });
  });

  it("stores the failure reason alongside the error status", () => {
    usePortaStore
      .getState()
      .setSessionStatus("s1", "error", undefined, 'Authentication failed for user "Nasrul\\ Gunawan"');

    const s = usePortaStore.getState().sshSessions[0];
    expect(s.status).toBe("error");
    expect(s.error).toContain("Authentication failed");
  });

  it("keeps an existing reason when a later event re-asserts error without one", () => {
    const { setSessionStatus } = usePortaStore.getState();
    setSessionStatus("s1", "error", undefined, "connect: Connection refused");
    setSessionStatus("s1", "error");
    expect(usePortaStore.getState().sshSessions[0].error).toBe("connect: Connection refused");
  });

  it("clears the reason once the session reconnects", () => {
    const { setSessionStatus } = usePortaStore.getState();
    setSessionStatus("s1", "error", undefined, "host key not trusted");
    setSessionStatus("s1", "connected", "ssh-ed25519");

    const s = usePortaStore.getState().sshSessions[0];
    expect(s.status).toBe("connected");
    expect(s.error).toBeNull();
    expect(s.keyType).toBe("ssh-ed25519");
  });

  it("leaves other sessions untouched", () => {
    usePortaStore.setState({
      sshSessions: [
        session({ id: "s1", status: "connected", phase: "connected" }),
        session({ id: "s2", hostId: "h2", label: "vps" }),
      ],
    });
    usePortaStore.getState().setSessionStatus("s2", "error", undefined, "nope");
    const [a, b] = usePortaStore.getState().sshSessions;
    expect(a.status).toBe("connected");
    expect(b.error).toBe("nope");
  });

  // The connect overlay reads `phase`, not `status` — all four handshake gates
  // report status "connecting", so a stale phase would leave the progress list
  // spinning on a step the backend has already walked past.
  it("advances the handshake phase independently of the coarse status", () => {
    const { setSessionPhase } = usePortaStore.getState();
    setSessionPhase("s1", "authenticating");
    const s = usePortaStore.getState().sshSessions[0];
    expect(s.phase).toBe("authenticating");
    expect(s.status).toBe("connecting");
  });

  it("snaps the phase to a terminal state when the session fails or lands", () => {
    const { setSessionStatus } = usePortaStore.getState();
    setSessionStatus("s1", "error", undefined, "nope");
    expect(usePortaStore.getState().sshSessions[0].phase).toBe("error");

    setSessionStatus("s1", "connected");
    expect(usePortaStore.getState().sshSessions[0].phase).toBe("connected");
  });
});

/**
 * A snippet is typed into a live PTY. Running one against a session that isn't
 * connected has to fail loudly rather than write into the void — the shell it
 * would land in is exactly what makes a snippet useful.
 */
describe("running a snippet", () => {
  const snippet = {
    id: "sn1",
    label: "Disk usage",
    command: "df -h",
    host_id: null,
    created_at: 0,
    last_used_at: null,
  };

  beforeEach(() => {
    usePortaStore.setState({
      sshSessions: [session({ id: "s1", status: "connecting" })],
      activeSessionId: "s1",
      sshSnippets: [snippet],
    });
  });

  it("refuses to run when the active session isn't connected yet", async () => {
    await expect(usePortaStore.getState().runSnippet(snippet)).rejects.toThrow(/live shell/i);
  });

  it("refuses to run when there is no session at all", async () => {
    usePortaStore.setState({ sshSessions: [], activeSessionId: null });
    await expect(usePortaStore.getState().runSnippet(snippet)).rejects.toThrow();
  });

  it("marks the snippet used once it runs, so the picker can float it up", async () => {
    usePortaStore.getState().setSessionStatus("s1", "connected");
    await usePortaStore.getState().runSnippet(snippet);
    expect(usePortaStore.getState().sshSnippets[0].last_used_at).not.toBeNull();
  });
});

/**
 * ⌘S reached the store directly, bypassing the Save button's guards. A binary
 * file is held with an empty draft because the editor refuses to decode it, so
 * one keystroke could replace a remote binary with nothing.
 */
describe("saving a remote file", () => {
  const base = {
    path: "/srv/app/logo.png",
    content: "",
    size: 4096,
    mtime: 100,
    permissions: 0o100644,
    binary: true,
    draft: "",
    saving: false,
    error: null,
    conflict: false,
  };

  beforeEach(() => {
    usePortaStore.setState({
      sshSessions: [session({ id: "s1", status: "connected" })],
      activeSessionId: "s1",
      sftpOpen: { s1: { ...base } },
    });
  });

  it("refuses to write a binary file", async () => {
    await usePortaStore.getState().sftpSaveFile("s1");
    // Never entered the saving state, so no write was attempted.
    expect(usePortaStore.getState().sftpOpen.s1.saving).toBe(false);
    expect(usePortaStore.getState().sftpOpen.s1.content).toBe("");
  });

  it("refuses when the buffer matches what is on the server", async () => {
    usePortaStore.setState({
      sftpOpen: { s1: { ...base, binary: false, content: "same", draft: "same" } },
    });
    await usePortaStore.getState().sftpSaveFile("s1");
    expect(usePortaStore.getState().sftpOpen.s1.saving).toBe(false);
  });

  it("writes when the buffer actually differs", async () => {
    usePortaStore.setState({
      sftpOpen: { s1: { ...base, binary: false, content: "old", draft: "new" } },
    });
    await usePortaStore.getState().sftpSaveFile("s1");
    expect(usePortaStore.getState().sftpOpen.s1.content).toBe("new");
  });
});
