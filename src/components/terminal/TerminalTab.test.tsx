import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import TerminalTab from "./TerminalTab";

const terminalOpen = vi.hoisted(() =>
  vi.fn(async (_appId: string, _rootDir: string, _rows: number, _cols: number, _startupCmd?: string | null) => ({
    spawned: true,
    backlog: [] as number[],
  })),
);
const terminalClose = vi.hoisted(() => vi.fn(async () => {}));
const terminalWrite = vi.hoisted(() => vi.fn(async () => {}));
const terminalResize = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../lib/commands", async (orig) => ({
  ...(await orig<typeof import("../../lib/commands")>()),
  terminalOpen,
  terminalClose,
  terminalWrite,
  terminalResize,
}));

describe("TerminalTab lifecycle", () => {
  beforeEach(() => {
    terminalOpen.mockClear();
    terminalClose.mockClear();
  });

  // The reported bug: navigating away unmounted this component, whose cleanup
  // SIGHUPed the shell. Unmounting is a view concern, not a session one.
  it("does not close the PTY when it unmounts", async () => {
    const { unmount } = render(
      <TerminalTab appId="pane-1" rootDir="/src/porta" visible />,
    );
    unmount();
    expect(terminalClose).not.toHaveBeenCalled();
  });

  it("opens the session for its pane id", async () => {
    render(<TerminalTab appId="pane-1" rootDir="/src/porta" visible />);
    await vi.waitFor(() => expect(terminalOpen).toHaveBeenCalled());
    expect(terminalOpen.mock.calls[0][0]).toBe("pane-1");
  });
});
