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
    container: HTMLElement | undefined;
    // Mirrors xterm's real (public, readonly) `textarea` property: the
    // hidden input it focuses on click/Tab/programmatic focus, and the only
    // reliable source of a real focus event — see Finding 3. Real xterm only
    // populates this inside `open()`, not before — undefined here until then
    // is what makes a test relying on the `term.textarea?.addEventListener`
    // fallback (rather than the real open()-then-listen order) fail instead
    // of silently passing.
    textarea: HTMLTextAreaElement | undefined;
    private onDataHandler: ((data: string) => void) | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminalInstances.push(this);
    }

    loadAddon() {}
    open(el: HTMLElement) {
      this.container = el;
      this.textarea = document.createElement("textarea");
    }
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

// Controllable per-test: defaults to a normal measured size, but Finding 1's
// test flips this to `undefined` to simulate a container that measures 0×0
// because it mounted into a `display:none` subtree.
const fitState = vi.hoisted(() => ({
  dims: { rows: 24, cols: 80 } as { rows: number; cols: number } | undefined,
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate() {}
    dispose() {}
    fit() {}
    proposeDimensions() {
      return fitState.dims;
    }
  },
}));

// Controllable ResizeObserver: the global stub in test/setup.ts is inert, but
// Finding 1's fix relies on the component's own observer noticing a size
// change, so this test file needs to be able to fire that callback by hand.
const { MockResizeObserver, roInstances } = vi.hoisted(() => {
  class MockResizeObserver {
    cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
      roInstances.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const roInstances: InstanceType<typeof MockResizeObserver>[] = [];
  return { MockResizeObserver, roInstances };
});
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

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
    roInstances.length = 0;
    fitState.dims = { rows: 24, cols: 80 };
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

  // Finding 1: a pane mounted into a `display:none` subtree (e.g. a
  // background app's auto-seeded tab, or a background split pane) measures
  // 0×0, so `proposeDimensions()` returns undefined and the mount effect used
  // to just give up — terminal_open was never called and nothing rescheduled
  // it, leaving a permanently blank pane. The fix must not fabricate a size
  // (that was tried and reverted — it spawns the shell at the wrong winsize
  // and hard-wraps its startup output); it must retry once the container
  // actually gets a real size, and open exactly once.
  it("opens the session once the container gains real dimensions, having bailed at mount for lack of any", async () => {
    fitState.dims = undefined;

    render(<TerminalTab appId="pane-6" rootDir="/src/porta" visible={false} />);

    // The listeners are registered up front regardless of dimensions — only
    // the open call itself is deferred.
    await vi.waitFor(() => expect(eventHandlers.has("terminal:data:pane-6")).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(terminalOpen).not.toHaveBeenCalled();

    // The container gains a real size — in production this is what flips
    // `getBoundingClientRect()` to non-zero and is what the ResizeObserver
    // exists to notice.
    const container = lastTerminal().container!;
    Object.defineProperty(container, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0,
        toJSON() { return {}; },
      }),
    });
    fitState.dims = { rows: 30, cols: 100 };

    roInstances[roInstances.length - 1].cb();

    await vi.waitFor(() => expect(terminalOpen).toHaveBeenCalledTimes(1));
    expect(terminalOpen).toHaveBeenCalledWith("pane-6", "/src/porta", 30, 100, null);

    // A later resize (the ordinary case ResizeObserver exists for) must not
    // reopen an already-open session.
    roInstances[roInstances.length - 1].cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(terminalOpen).toHaveBeenCalledTimes(1);
  });

  // Companion to the above: queued live chunks that arrived while the open
  // was deferred (the reattach case — a session that was already running
  // when this view mounted hidden) must still drain in order once the open
  // finally happens, exactly as they would have if dimensions had been
  // available immediately.
  it("drains chunks queued while the open was deferred for lack of dimensions", async () => {
    fitState.dims = undefined;
    let resolveOpen!: (v: { spawned: boolean; backlog: number[] }) => void;
    terminalOpen.mockImplementationOnce(
      () => new Promise((resolve) => { resolveOpen = resolve; }),
    );

    render(<TerminalTab appId="pane-7" rootDir="/src/porta" visible={false} />);
    await vi.waitFor(() => expect(eventHandlers.has("terminal:data:pane-7")).toBe(true));

    // A live chunk arrives while the pane is still hidden — before the open
    // has even been attempted.
    eventHandlers.get("terminal:data:pane-7")!({ payload: bytes("live-while-hidden") });

    const container = lastTerminal().container!;
    Object.defineProperty(container, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0,
        toJSON() { return {}; },
      }),
    });
    fitState.dims = { rows: 30, cols: 100 };
    roInstances[roInstances.length - 1].cb();

    await vi.waitFor(() => expect(terminalOpen).toHaveBeenCalledTimes(1));
    resolveOpen({ spawned: false, backlog: bytes("backlog-bytes") });

    await vi.waitFor(() => expect(lastTerminal().writes).toEqual(["backlog-bytes", "live-while-hidden"]));
  });

  // Finding A (blocker, review pass 2): `requestAnimationFrame(attach)` and
  // `ro.observe()` are armed in the same commit, but per the HTML rendering
  // steps, animation-frame callbacks run *before* resize observations are
  // broadcast in the same frame. `attach()` starts, immediately suspends at
  // `await Promise.all([listen(...), listen(...)])` (listener registration is
  // never synchronous — it's a real IPC round trip), and the observer's first
  // delivery — which for a *visible* pane already sees a non-zero rect, no
  // `display:none` deferral needed — must not race ahead and open the session
  // itself before those listeners exist. If it did, whatever the reader
  // thread emits in that window reaches neither the (not-yet-taken) backlog
  // snapshot nor a listener: silently dropped output.
  it("does not let the observer's first delivery call terminal_open before both listeners are registered, even on a visible pane", async () => {
    render(<TerminalTab appId="pane-9" rootDir="/src/porta" visible />);

    // Real dimensions from the very first delivery — this is the ordinary
    // visible-mount case, not Finding 1's hidden-pane deferral.
    const container = lastTerminal().container!;
    Object.defineProperty(container, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0,
        toJSON() { return {}; },
      }),
    });

    // Fire the observer's callback synchronously, before `attach()` (queued
    // via `requestAnimationFrame`, a real timer in jsdom) has even started —
    // a strictly earlier-arriving delivery than the same-frame race this
    // finding describes, so if this doesn't call terminal_open, neither does
    // the real race.
    roInstances[roInstances.length - 1].cb();

    expect(terminalOpen).not.toHaveBeenCalled();

    // The open must still happen — once, through attach()'s own normal path
    // once its listeners are actually up.
    await vi.waitFor(() => expect(terminalOpen).toHaveBeenCalledTimes(1));
    expect(terminalOpen).toHaveBeenCalledWith("pane-9", "/src/porta", 24, 80, null);

    // A later, ordinary resize delivery must not reopen it.
    roInstances[roInstances.length - 1].cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(terminalOpen).toHaveBeenCalledTimes(1);
  });

  // Finding 3: `Terminal.prototype.onFocus` isn't public API (it belongs to
  // xterm's internal core terminal), so the previous cast-and-optional-call
  // was a permanent no-op — `focusedPaneId` in TerminalWorkspace could never
  // become non-null, which silently kills the split-view focus ring, pins
  // Restart to pane 1 forever, and (pre Finding 4) pins the poll to pane 1
  // too. `textarea` is the real, public, always-present focus target xterm
  // uses; a native listener on it is what this test pins.
  it("calls onFocus when the terminal's textarea receives a real focus event", async () => {
    const onFocus = vi.fn();
    render(<TerminalTab appId="pane-8" rootDir="/src/porta" visible onFocus={onFocus} />);
    await vi.waitFor(() => expect(terminalOpen).toHaveBeenCalled());

    lastTerminal().textarea!.dispatchEvent(new FocusEvent("focus"));

    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
