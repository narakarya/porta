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
  // Force the Tauri branch so `attach()` registers `terminal:data`/`terminal:exit`
  // listeners — that's the path the ordering contract (Finding 3) lives on.
  isTauri: true,
}));

// Drive the `terminal:data`/`terminal:exit` listeners the component registers,
// instead of the setup.ts default that swallows the handler.
type EventHandler = (e: { payload: unknown }) => void;
const eventHandlers = vi.hoisted(() => new Map<string, EventHandler>());
const listenMock = vi.hoisted(() =>
  vi.fn(async (event: string, handler: EventHandler) => {
    eventHandlers.set(event, handler);
    return () => {
      eventHandlers.delete(event);
    };
  }),
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
  emit: vi.fn(async () => {}),
}));

// Fully mock xterm so tests don't depend on jsdom's (absent) canvas text
// measurement, and so `write`/`writeln` calls can be observed in order.
const { MockTerminal, terminalInstances } = vi.hoisted(() => {
  class MockTerminal {
    rows = 24;
    cols = 80;
    options: Record<string, unknown>;
    writes: string[] = [];
    private onDataHandler: ((data: string) => void) | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminalInstances.push(this);
    }

    loadAddon() {}
    open() {}
    onData(cb: (data: string) => void) {
      this.onDataHandler = cb;
    }
    emitInput(data: string) {
      this.onDataHandler?.(data);
    }
    write(data: Uint8Array | string) {
      this.writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    }
    writeln(data: string) {
      this.writes.push(data);
    }
    refresh() {}
    dispose() {}
  }
  const terminalInstances: InstanceType<typeof MockTerminal>[] = [];
  return { MockTerminal, terminalInstances };
});
vi.mock("@xterm/xterm", () => ({ Terminal: MockTerminal }));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate() {}
    dispose() {}
    fit() {}
    proposeDimensions() {
      return { rows: 24, cols: 80 };
    }
  },
}));

function bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function lastTerminal(): InstanceType<typeof MockTerminal> {
  const term = terminalInstances[terminalInstances.length - 1];
  if (!term) throw new Error("no MockTerminal instance created");
  return term;
}

describe("TerminalTab lifecycle", () => {
  beforeEach(() => {
    terminalOpen.mockClear();
    terminalClose.mockClear();
    terminalWrite.mockClear();
    terminalResize.mockClear();
    listenMock.mockClear();
    eventHandlers.clear();
    terminalInstances.length = 0;
  });

  // The reported bug: navigating away unmounted this component, whose cleanup
  // SIGHUPed the shell. Unmounting is a view concern, not a session one.
  it("does not close the PTY when it unmounts", async () => {
    const { unmount } = render(
      <TerminalTab appId="pane-1" rootDir="/src/porta" visible />,
    );
    await vi.waitFor(() => expect(terminalOpen).toHaveBeenCalled());
    unmount();
    expect(terminalClose).not.toHaveBeenCalled();
  });

  it("opens the session for its pane id", async () => {
    render(<TerminalTab appId="pane-2" rootDir="/src/porta" visible />);
    await vi.waitFor(() => expect(terminalOpen).toHaveBeenCalled());
    expect(terminalOpen.mock.calls[0][0]).toBe("pane-2");
  });

  it("writes a live chunk that arrives mid-attach after the backlog, not before", async () => {
    let resolveOpen!: (v: { spawned: boolean; backlog: number[] }) => void;
    terminalOpen.mockImplementationOnce(
      () => new Promise((resolve) => { resolveOpen = resolve; }),
    );

    render(<TerminalTab appId="pane-3" rootDir="/src/porta" visible />);

    await vi.waitFor(() => expect(eventHandlers.has("terminal:data:pane-3")).toBe(true));

    // A chunk arrives while terminalOpen is still in flight.
    eventHandlers.get("terminal:data:pane-3")!({ payload: bytes("live-first") });

    // Nothing should be written yet — terminalOpen hasn't resolved.
    expect(lastTerminal().writes).toEqual([]);

    resolveOpen({ spawned: true, backlog: bytes("backlog-bytes") });

    await vi.waitFor(() => expect(lastTerminal().writes.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(lastTerminal().writes.length).toBe(2));

    expect(lastTerminal().writes).toEqual(["backlog-bytes", "live-first"]);
  });

  it("drains the queue exactly once — a later chunk is written immediately, not duplicated", async () => {
    terminalOpen.mockResolvedValueOnce({ spawned: true, backlog: bytes("backlog") });

    render(<TerminalTab appId="pane-4" rootDir="/src/porta" visible />);

    await vi.waitFor(() => expect(eventHandlers.has("terminal:data:pane-4")).toBe(true));
    await vi.waitFor(() => expect(lastTerminal().writes).toEqual(["backlog"]));

    eventHandlers.get("terminal:data:pane-4")!({ payload: bytes("second") });

    await vi.waitFor(() => expect(lastTerminal().writes).toEqual(["backlog", "second"]));
  });

  it("passes the numeric exit code from the event payload to onExit", async () => {
    const onExit = vi.fn();
    terminalOpen.mockResolvedValueOnce({ spawned: true, backlog: [] });

    render(<TerminalTab appId="pane-5" rootDir="/src/porta" visible onExit={onExit} />);

    await vi.waitFor(() => expect(eventHandlers.has("terminal:exit:pane-5")).toBe(true));

    eventHandlers.get("terminal:exit:pane-5")!({ payload: { code: 3 } });

    expect(onExit).toHaveBeenCalledWith(3);
  });
});
