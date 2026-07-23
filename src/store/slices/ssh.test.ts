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
