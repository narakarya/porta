import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePortaStore } from "../../store";
import type { SshSession } from "../../store/slices/ssh";
import SshSessionTabs from "./SshSessionTabs";

// The real terminal boots xterm against a canvas jsdom can't paint. The point
// here is what renders INSTEAD of it for a failed session.
vi.mock("./SshTerminal", () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid={`term-${sessionId}`} />,
}));

function seed(status: SshSession["status"], error?: string, over: Partial<SshSession> = {}) {
  usePortaStore.setState({
    sshSessions: [
      {
        id: "s1",
        hostId: "h1",
        label: "NAS",
        status,
        phase: status === "connected" || status === "error" ? status : "connecting",
        startedAt: Date.now(),
        error: error ?? null,
        ...over,
      },
    ],
    activeSessionId: "s1",
  });
}

describe("SshSessionTabs", () => {
  beforeEach(() => {
    usePortaStore.setState({ sshSessions: [], activeSessionId: null, sshPrompt: null, sshHosts: [] });
  });

  it("shows the failure reason instead of an empty terminal", () => {
    seed("error", 'Authentication failed for user "Nasrul\\ Gunawan" (tried: agent)');
    render(<SshSessionTabs />);

    expect(screen.getByText(/Couldn't connect to NAS/)).toBeInTheDocument();
    expect(screen.getByText(/Authentication failed for user/)).toBeInTheDocument();
    // The blank-terminal-behind-a-red-dot bug: the terminal must NOT be what
    // a failed session renders.
    expect(screen.queryByTestId("term-s1")).not.toBeInTheDocument();
  });

  it("falls back to a generic reason rather than rendering nothing", () => {
    seed("error");
    render(<SshSessionTabs />);
    expect(screen.getByText("Connection failed")).toBeInTheDocument();
  });

  it("still renders the terminal for a healthy session", () => {
    seed("connected");
    render(<SshSessionTabs />);
    expect(screen.getByTestId("term-s1")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't connect/)).not.toBeInTheDocument();
  });

  it("retry replaces the failed session instead of stacking a new tab", async () => {
    const connectSsh = vi.fn(async () => {});
    const disconnectSsh = vi.fn(async () => {});
    seed("error", "connect: Connection refused");
    usePortaStore.setState({ connectSsh, disconnectSsh });

    render(<SshSessionTabs />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    // Dropping the dead session first is the point: retrying without it left
    // one more red tab behind on every attempt.
    expect(disconnectSsh).toHaveBeenCalledWith("s1");
    expect(connectSsh).toHaveBeenCalledWith("h1");
  });

  // The handshake used to render as a blank black pane behind an amber dot.
  describe("while connecting", () => {
    it("shows the handshake steps over the terminal, not instead of it", () => {
      seed("connecting", undefined, { phase: "authenticating" });
      render(<SshSessionTabs />);

      // Mounted, so its data listener is live before the shell's first byte.
      expect(screen.getByTestId("term-s1")).toBeInTheDocument();
      // Current gate is spelled out; cleared gates read from the chain itself.
      expect(screen.getByText("Authenticating")).toBeInTheDocument();
      expect(screen.getByTitle("Reached")).toBeInTheDocument();
      expect(screen.getByTitle("Verified")).toBeInTheDocument();
      expect(screen.getByTitle("Starting shell")).toBeInTheDocument(); // still pending
    });

    it("says who is being waited on when a prompt is parked mid-handshake", () => {
      seed("connecting", undefined, { phase: "authenticating" });
      usePortaStore.setState({ sshPrompt: { sessionId: "s1", type: "secret", kind: "password" } });
      render(<SshSessionTabs />);

      expect(screen.getByText("Waiting for the password")).toBeInTheDocument();
      expect(screen.queryByText("Authenticating")).not.toBeInTheDocument();
    });

    it("cancelling tears the half-open session down", async () => {
      const disconnectSsh = vi.fn(async () => {});
      seed("connecting");
      usePortaStore.setState({ disconnectSsh });

      render(<SshSessionTabs />);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(disconnectSsh).toHaveBeenCalledWith("s1");
    });

    it("drops the overlay once the shell is live", () => {
      seed("connected");
      render(<SshSessionTabs />);
      expect(screen.queryByText("Reaching host")).not.toBeInTheDocument();
    });
  });
});
