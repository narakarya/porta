import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePortaStore } from "../../store";
import SshSessionTabs from "./SshSessionTabs";

// The real terminal boots xterm against a canvas jsdom can't paint. The point
// here is what renders INSTEAD of it for a failed session.
vi.mock("./SshTerminal", () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid={`term-${sessionId}`} />,
}));

function seed(status: "connected" | "error", error?: string) {
  usePortaStore.setState({
    sshSessions: [{ id: "s1", hostId: "h1", label: "NAS", status, error: error ?? null }],
    activeSessionId: "s1",
  });
}

describe("SshSessionTabs", () => {
  beforeEach(() => {
    usePortaStore.setState({ sshSessions: [], activeSessionId: null });
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

  it("retry reconnects the same host", async () => {
    const connectSsh = vi.fn(async () => {});
    seed("error", "connect: Connection refused");
    usePortaStore.setState({ connectSsh });

    render(<SshSessionTabs />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(connectSsh).toHaveBeenCalledWith("h1");
  });
});
