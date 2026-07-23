import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { usePortaStore } from "../../store";
import TerminalWorkspace, { tabState } from "./TerminalWorkspace";
import type { TerminalState } from "../../lib/commands";

const terminalClose = vi.hoisted(() => vi.fn(async () => {}));
const terminalState = vi.hoisted(() => vi.fn());
vi.mock("../../lib/commands", async (orig) => ({
  ...(await orig<typeof import("../../lib/commands")>()),
  terminalClose,
  terminalState,
}));

const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmDialog }));

// Captured per pane id so tests can drive `onLineCount`/`onFocus` at will,
// independent of mount timing — a real TerminalTab reports these from its
// xterm instance, which this double doesn't have.
const paneProps = vi.hoisted(
  () =>
    new Map<
      string,
      { onLineCount?: (lineCount: number) => void; onFocus?: () => void; onSearchResults?: (index: number, count: number) => void }
    >(),
);
// appId -> the instance token that currently owns that entry. A remount (a
// `key` change on the pane's wrapping element) mounts the new instance
// before the old one's cleanup commits — the new instance's render (which
// calls `paneProps.set` below) runs first, then only later does the old
// instance's `useEffect` cleanup fire. Without this, that cleanup would
// unconditionally delete the entry the new instance already wrote, leaving
// `paneProps` empty after every remount. Each instance only deletes its own
// entry — recognized by still owning it at cleanup time — never one a newer
// instance has since claimed.
const paneOwners = vi.hoisted(() => new Map<string, symbol>());

// Every `find` the workspace routes to a pane, in order — the real handle is
// backed by xterm's SearchAddon, which has no buffer to search in jsdom.
const searchCalls = vi.hoisted(() => [] as Array<{ paneId: string; term: string; direction: string; incremental?: boolean }>);

// xterm paints to a canvas jsdom can't render; the tab strip is what's under test.
vi.mock("./TerminalTab", () => ({
  default: (props: {
    appId: string;
    onLineCount?: (lineCount: number) => void;
    onFocus?: () => void;
    onSearchResults?: (index: number, count: number) => void;
    registerSearch?: (api: { find: (t: string, d: "next" | "prev", i?: boolean) => void; clear: () => void } | null) => void;
  }) => {
    const instanceToken = useRef<symbol | undefined>(undefined);
    if (instanceToken.current === undefined) instanceToken.current = Symbol(props.appId);
    paneProps.set(props.appId, props);
    paneOwners.set(props.appId, instanceToken.current);
    const paneId = props.appId;
    const register = props.registerSearch;
    useEffect(() => {
      register?.({
        find: (term, direction, incremental) => searchCalls.push({ paneId, term, direction, incremental }),
        clear: () => searchCalls.push({ paneId, term: "", direction: "clear" }),
      });
      return () => register?.(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [paneId]);
    // Runs once per mount *and* once per remount (a `key` change forces a
    // fresh instance) — nothing else in this double depends on appId.
    useEffect(() => () => {
      if (paneOwners.get(props.appId) === instanceToken.current) {
        paneProps.delete(props.appId);
        paneOwners.delete(props.appId);
      }
    }, [props.appId]);
    return <div data-testid={`pane-${props.appId}`} />;
  },
}));

// Every test in this file renders a TerminalWorkspace, whose poll effect
// fires an immediate `terminalState` call on mount — give it a harmless
// default so tests that don't care about polling don't have to.
beforeEach(() => {
  terminalState.mockReset();
  terminalState.mockResolvedValue({ alive: true, running: false, pid: 0, exitCode: null } satisfies TerminalState);
  paneProps.clear();
  searchCalls.length = 0;
});

describe("find widget", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
  });

  const lastSearch = () => searchCalls[searchCalls.length - 1];

  async function openFind() {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const paneId = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;
    await userEvent.click(screen.getByTitle("Find in terminal output (⌘F)"));
    const input = screen.getByPlaceholderText("Find in output…");
    // Opening focuses *and selects* on the next animation frame, so typing
    // before that lands would have its first character replaced by the
    // select-all — the same thing that makes reopening replace the old query.
    await waitFor(() => expect(input).toHaveFocus());
    return { paneId, input };
  }

  it("searches the pane's own buffer as you type, incrementally", async () => {
    const { paneId, input } = await openFind();
    searchCalls.length = 0;

    await userEvent.type(input, "warn");

    const typed = searchCalls.filter((c) => c.direction === "next");
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.every((c) => c.paneId === paneId && c.incremental === true)).toBe(true);
    expect(typed[typed.length - 1].term).toBe("warn");
  });

  it("steps forward on Enter and backward on Shift+Enter", async () => {
    const { input } = await openFind();
    await userEvent.type(input, "warn");
    searchCalls.length = 0;

    await userEvent.type(input, "{Enter}");
    // Not incremental: Enter must leave the current match and go to the next
    // one, where typing only ever extends the match already selected.
    expect(lastSearch()).toMatchObject({ term: "warn", direction: "next", incremental: false });

    await userEvent.type(input, "{Shift>}{Enter}{/Shift}");
    expect(lastSearch()).toMatchObject({ term: "warn", direction: "prev" });
  });

  it("reports the active match position from the pane, not a line tally", async () => {
    const { paneId, input } = await openFind();
    await userEvent.type(input, "warn");

    act(() => paneProps.get(paneId)?.onSearchResults?.(2, 9));
    expect(screen.getByText("3/9")).toBeInTheDocument();

    act(() => paneProps.get(paneId)?.onSearchResults?.(-1, 0));
    expect(screen.getByText("no results")).toBeInTheDocument();
  });

  it("clears every pane's highlights when the widget closes", async () => {
    const { paneId, input } = await openFind();
    await userEvent.type(input, "warn");
    searchCalls.length = 0;

    await userEvent.click(screen.getByTitle("Close (Esc)"));

    expect(searchCalls).toContainEqual({ paneId, term: "", direction: "clear" });
    expect(screen.queryByPlaceholderText("Find in output…")).not.toBeInTheDocument();
  });
});

describe("TerminalWorkspace", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
    terminalClose.mockClear();
  });

  it("seeds a tab for the app it is given", () => {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    expect(usePortaStore.getState().terminalTabs["a1"]).toHaveLength(1);
    expect(screen.getByText("zsh")).toBeInTheDocument();
  });

  // The reported bug: switching apps left the previous app's tabs on screen.
  it("swaps the tab set when the app changes", () => {
    const { rerender } = render(
      <TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />,
    );
    usePortaStore.getState().renameTerminalTab("a1", usePortaStore.getState().terminalTabs["a1"][0].id, "porta-shell");
    rerender(<TerminalWorkspace appId="a2" appName="smartuq" rootDir="/src/smartuq" active autoSeed />);

    expect(screen.queryByText("porta-shell")).not.toBeInTheDocument();
    expect(usePortaStore.getState().terminalTabs["a2"]).toHaveLength(1);
  });

  it("keeps the previous app's sessions alive across the switch", () => {
    const { rerender } = render(
      <TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />,
    );
    rerender(<TerminalWorkspace appId="a2" appName="smartuq" rootDir="/src/smartuq" active autoSeed />);

    expect(terminalClose).not.toHaveBeenCalled();
    expect(usePortaStore.getState().terminalTabs["a1"]).toHaveLength(1);
  });

  it("restores the same tabs when the app comes back", () => {
    const { rerender } = render(
      <TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />,
    );
    const original = usePortaStore.getState().terminalTabs["a1"][0].id;
    rerender(<TerminalWorkspace appId="a2" appName="smartuq" rootDir="/src/smartuq" active autoSeed />);
    rerender(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);

    expect(usePortaStore.getState().terminalTabs["a1"][0].id).toBe(original);
    expect(usePortaStore.getState().terminalTabs["a1"]).toHaveLength(1);
  });
});

describe("pane chrome", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
  });

  // The duplicated row: the tab already says `zsh` directly above it.
  it("renders no pane label for a single-pane tab", () => {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    expect(screen.queryByText("porta · zsh")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pane-ordinal")).not.toBeInTheDocument();
  });

  it("numbers the panes once a tab is split", () => {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const tabId = usePortaStore.getState().terminalTabs["a1"][0].id;
    act(() => {
      usePortaStore.getState().splitTerminalTab("a1", tabId, "cols");
    });

    const ordinals = screen.getAllByTestId("pane-ordinal");
    expect(ordinals.map((o) => o.textContent)).toEqual(["1", "2"]);
  });
});

describe("tabState", () => {
  const base = {
    id: "t1", appId: "a1", appName: "porta", rootDir: "/src/porta",
    label: "zsh", splitOrientation: "cols" as const,
  };
  const pane = (state: "idle" | "running" | "exited") => ({
    id: `p-${state}`, rootDir: "/src/porta", startupCommand: null,
    hasUnseenOutput: false, state, exitCode: null, pid: null,
  });

  it("is running when any pane has work in flight", () => {
    expect(tabState({ ...base, panes: [pane("idle"), pane("running")] })).toBe("running");
  });

  it("is exited only when every pane has exited", () => {
    expect(tabState({ ...base, panes: [pane("exited"), pane("exited")] })).toBe("exited");
    expect(tabState({ ...base, panes: [pane("exited"), pane("idle")] })).toBe("idle");
  });

  it("is idle at a bare prompt", () => {
    expect(tabState({ ...base, panes: [pane("idle")] })).toBe("idle");
  });
});

describe("focused-pane poll", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Finding 1: TerminalTab's mount effect only *schedules* the
  // requestAnimationFrame that eventually calls terminalOpen, so this poll's
  // first tick can reach Rust before terminal_open does. Rust answers "no
  // such terminal session" for that — the exact same string it returns for a
  // tab mid-close — and (at the time this test was written) commands.ts
  // mapped both to `{ alive: false, ... }`, so the poll wrote `exited` onto
  // a pane whose shell was about to come up fine.
  it("leaves a fresh pane's state untouched when Rust has no record of the session yet", async () => {
    // This is what the *current* terminalState contract hands back for "no
    // such terminal session" — see the RED evidence in the task report for
    // what this test caught before terminalState's contract changed to
    // resolve `null` for this case instead.
    terminalState.mockResolvedValue(null);

    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const pane = usePortaStore.getState().terminalTabs["a1"][0].panes[0];
    expect(pane.state).toBe("idle");
    expect(pane.exitCode).toBeNull();
    expect(pane.pid).toBeNull();
  });

  // Finding 6 (poll-loop regression guard): the effect's dep array must key
  // on the focused pane's *id* (a stable primitive), not the pane object —
  // `setTerminalPaneState` always produces a fresh pane object on every
  // write (no value diff before the spread), so depending on the object
  // would restart the interval, and re-fire its immediate tick(), on every
  // single successful poll: a 2s poll turned into an IPC-paced storm. This
  // test would fail (call count far past the asserted bound) if that
  // dependency regressed.
  it("polls on a fixed ~2s cadence rather than once per store write", async () => {
    vi.useFakeTimers();
    terminalState.mockResolvedValue({ alive: true, running: false, pid: 42, exitCode: null } satisfies TerminalState);

    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Immediate tick at mount + ticks at 2s/4s/6s/8s/10s = 6 calls if the
    // cadence is honored. A regressed dep array produces dozens to hundreds
    // in the same window, so a generous upper bound still catches it.
    expect(terminalState.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(terminalState.mock.calls.length).toBeLessThanOrEqual(7);
  });

  // Finding 2 (fix pass 2): absence used to be bounded — past enough
  // consecutive `null` responses the poll gave up and wrote `exited`. That
  // turned a merely-slow-to-attach session into a dead end with no way to
  // heal, and it's reachable without any real failure: `TerminalTab` defers
  // its `terminal_open` call into a `requestAnimationFrame`, which is
  // suspended entirely while the window is occluded or minimized — so
  // cmd-tabbing away for ten seconds and back would trip the old bound on a
  // perfectly live pane. There is no bound anymore: absence alone must never
  // produce a terminal state, no matter how long it persists. A genuine
  // spawn failure is surfaced separately by `terminal_open` itself.
  it("never gives up on an absent session, however many ticks it stays absent", async () => {
    vi.useFakeTimers();
    terminalState.mockResolvedValue(null);

    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const paneId = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    // Comfortably past the old 5-tick (~8s) bound this finding removes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    const pane = usePortaStore.getState().terminalTabs["a1"][0].panes.find((p) => p.id === paneId)!;
    expect(pane.state).toBe("idle");
    expect(pane.exitCode).toBeNull();
    expect(pane.pid).toBeNull();
    // Still polling, not stuck — a regressed early-return (e.g. treating
    // `null` as fatal) would have stopped issuing calls well before 60s.
    expect(terminalState.mock.calls.length).toBeGreaterThan(20);
  });

  // Companion to the above: absence is genuinely transient, not just
  // tolerated forever in a vacuum — once Rust actually reports the session
  // (after however many `null`s), the poll picks that response up normally
  // on the very next tick, same as if it had never been absent.
  it("resumes normally once a real response follows one or more nulls", async () => {
    vi.useFakeTimers();
    terminalState.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const paneId = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    // Mount tick + 2 more ticks (4s) all resolve null.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    let pane = usePortaStore.getState().terminalTabs["a1"][0].panes.find((p) => p.id === paneId)!;
    expect(pane.state).toBe("idle");
    expect(pane.pid).toBeNull();

    // The session finally shows up as running.
    terminalState.mockResolvedValue({ alive: true, running: true, pid: 77, exitCode: null } satisfies TerminalState);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    pane = usePortaStore.getState().terminalTabs["a1"][0].panes.find((p) => p.id === paneId)!;
    expect(pane.state).toBe("running");
    expect(pane.pid).toBe(77);
  });
});

describe("restartFocusedPane", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
    terminalClose.mockClear();
  });

  it("closes the session, resets the pane to idle, drops its line count, and remounts the pane", async () => {
    // Isolate the restart's own store writes from the poll's: a real poll
    // tick landing after the reset would (correctly) overwrite `pid: null`
    // with whatever pid the freshly reopened shell reports, which is exactly
    // the right behavior in the app but would race this assertion.
    terminalState.mockImplementation(() => new Promise(() => {}));

    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const paneId = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    act(() => {
      paneProps.get(paneId)?.onLineCount?.(7);
      usePortaStore.getState().setTerminalPaneState("a1", paneId, { state: "exited", exitCode: 1, pid: 555 });
    });
    expect(screen.getByText("7 lines")).toBeInTheDocument();

    const nodeBefore = screen.getByTestId(`pane-${paneId}`);

    await userEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(usePortaStore.getState().terminalTabs["a1"][0].panes[0].state).toBe("idle");
    });

    expect(terminalClose).toHaveBeenCalledWith(paneId);

    const pane = usePortaStore.getState().terminalTabs["a1"][0].panes[0];
    expect(pane.exitCode).toBeNull();
    expect(pane.pid).toBeNull();

    // Dropped, not repopulated — this double doesn't auto-report stats on
    // mount, so a surviving cache entry would still read "7 lines".
    expect(screen.getByText("0 lines")).toBeInTheDocument();

    // A `key` change forces React to discard the old DOM node and mount a
    // fresh one even though the rendered markup is identical, so node
    // identity is what actually distinguishes a remount from a re-render.
    const nodeAfter = screen.getByTestId(`pane-${paneId}`);
    expect(nodeAfter).not.toBe(nodeBefore);

    // Finding 5: the double's bookkeeping must survive the remount — the
    // new instance registers before the old instance's cleanup fires, so a
    // naive unconditional delete on cleanup would wipe the entry the new
    // instance just wrote, leaving `paneProps` empty here.
    expect(paneProps.has(paneId)).toBe(true);
  });

  // Finding 2: without a pending-restart guard, two fast clicks dispatch two
  // terminalClose calls and two nonce bumps for the same pane — and if they
  // land out of order, the second close can hit the fresh PTY the first
  // restart just opened instead of the dead one it was meant for.
  it("ignores a second click while the first restart is still in flight", async () => {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const paneId = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    act(() => {
      usePortaStore.getState().setTerminalPaneState("a1", paneId, { state: "exited", exitCode: 1, pid: 1 });
    });

    let resolveClose!: () => void;
    terminalClose.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveClose = resolve; }));

    const restartBtn = screen.getByRole("button", { name: "Restart" });
    await userEvent.click(restartBtn);
    // The first close hasn't resolved, so the pane is still "exited" and the
    // button is still on screen — click it again to race the two.
    await userEvent.click(restartBtn);

    resolveClose();
    await waitFor(() => {
      expect(usePortaStore.getState().terminalTabs["a1"][0].panes[0].state).toBe("idle");
    });

    expect(terminalClose).toHaveBeenCalledTimes(1);
  });

  // Finding 1 (fix pass 2): the staleness guard compares the live restart
  // generation (via a ref) against the generation a poll response's request
  // was issued under. The bug was that the ref only got updated in the
  // render body, so it lagged one render behind `restartFocusedPane`'s
  // synchronous zustand store write — a poll response landing in that exact
  // gap read the pre-restart generation as still "current" and clobbered the
  // freshly-reset pane. This test drives that interleaving directly instead
  // of relying on timing: resolve the restart's `terminalClose` (which does
  // the store writes + nonce bump) first, then resolve a poll response that
  // was already in flight *before* the restart — simulating it landing right
  // after the store write but before anything else has re-rendered.
  it("does not let a poll response already in flight before Restart clobber the freshly-reset pane", async () => {
    let resolveStalePoll!: (v: TerminalState | null) => void;
    terminalState.mockImplementationOnce(
      () => new Promise<TerminalState | null>((resolve) => { resolveStalePoll = resolve; }),
    );
    // Any *later* call — notably the fresh tick the post-restart effect
    // instance fires immediately once it's installed — must not resolve
    // during this test, or it would write its own (correct) state and mask
    // whether the stale response above was actually discarded.
    terminalState.mockImplementation(() => new Promise<TerminalState | null>(() => {}));

    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const paneId = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    // The mount's immediate tick already called terminalState and is now
    // in flight (its promise held open by `resolveStalePoll` above). Mark
    // the pane exited out of band (as `onExit` would) so Restart appears —
    // this does not touch the poll effect's deps or generation.
    act(() => {
      // pid 999 here vs. 555 in the stale response below so a clobber is
      // unambiguous in either direction — if the guard fails, the final pid
      // is the stale response's 555; if it never even applied, it'd be 999.
      usePortaStore.getState().setTerminalPaneState("a1", paneId, { state: "exited", exitCode: 1, pid: 999 });
    });

    let resolveClose!: () => void;
    terminalClose.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveClose = resolve; }));

    await userEvent.click(screen.getByRole("button", { name: "Restart" }));

    // Timing chosen empirically to land the stale response in the exact gap
    // the fix closes: one microtask turn after `resolveClose()` gets past
    // the `terminalClose(...).catch(() => {})` no-op stage and *into*
    // `restartFocusedPane`'s real `.then()` handler (confirmed by
    // instrumenting both handlers directly) — i.e. the store's `idle` write
    // has already landed by the time the stale response's own `.then()`
    // runs. Resolving any later loses the race to the poll effect's own
    // cleanup/re-setup (which tears down on the nonce bump), and would then
    // pass via the unrelated `cancelled` guard instead of exercising the
    // generation check this test targets.
    await act(async () => {
      resolveClose();
      await Promise.resolve();

      resolveStalePoll({ alive: false, running: false, pid: 555, exitCode: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });

    const pane = usePortaStore.getState().terminalTabs["a1"][0].panes.find((p) => p.id === paneId)!;
    expect(pane.state).toBe("idle");
    expect(pane.pid).toBeNull();
  });
});

// Finding 3: TerminalTab's `onFocus` prop used to be wired to a call that was
// a permanent no-op (`Terminal.prototype.onFocus` isn't public xterm API),
// so `focusedPaneId` here could never become non-null — Restart was
// permanently pinned to pane 1, and the split-view focus edge never
// rendered, regardless of which pane the user actually typed into. These
// tests drive the same `onFocus` prop a real (fixed) TerminalTab now calls
// from a native `focus` listener on its xterm textarea (see
// TerminalTab.test.tsx for that half), and check the downstream effects here
// that would stay broken if this wiring ever regressed to a no-op.
describe("focused pane tracking", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
    terminalClose.mockClear();
  });

  it("routes Restart to whichever pane last took focus, not always pane 1", async () => {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const tabId = usePortaStore.getState().terminalTabs["a1"][0].id;
    act(() => {
      usePortaStore.getState().splitTerminalTab("a1", tabId, "cols");
    });
    const [pane1, pane2] = usePortaStore.getState().terminalTabs["a1"][0].panes;

    act(() => {
      paneProps.get(pane2.id)?.onFocus?.();
    });
    act(() => {
      usePortaStore.getState().setTerminalPaneState("a1", pane2.id, { state: "exited", exitCode: 1, pid: 9 });
    });

    await userEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() => expect(terminalClose).toHaveBeenCalledWith(pane2.id));
    expect(terminalClose).not.toHaveBeenCalledWith(pane1.id);
  });

  it("renders the split-view focus edge on whichever pane last took focus", () => {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const tabId = usePortaStore.getState().terminalTabs["a1"][0].id;
    act(() => {
      usePortaStore.getState().splitTerminalTab("a1", tabId, "cols");
    });
    const [pane1, pane2] = usePortaStore.getState().terminalTabs["a1"][0].panes;

    act(() => {
      paneProps.get(pane2.id)?.onFocus?.();
    });

    // The mock's own div → the "relative flex-1 min-h-0" wrapper → the pane
    // wrapper that actually carries the focus-edge class.
    const pane1Wrapper = screen.getByTestId(`pane-${pane1.id}`).parentElement!.parentElement!;
    const pane2Wrapper = screen.getByTestId(`pane-${pane2.id}`).parentElement!.parentElement!;
    expect(pane2Wrapper.className).toMatch(/shadow-\[inset/);
    expect(pane1Wrapper.className).not.toMatch(/shadow-\[inset/);
  });
});

// Finding 4 (fix pass 2): the previous pass's regression test for the "no
// such terminal session" mapping mocked `terminalState` wholesale (see the
// `beforeEach`/`vi.mock` at the top of this file), so it never actually
// exercised the mapping in `commands.ts` — reverting that file's `.catch`
// handler to its old `{ alive: false, ... }` behavior leaves every test in
// this file green. These tests call the *real*, unmocked `terminalState` to
// pin that contract directly: `vi.importActual` bypasses this file's own
// `vi.mock` for "../../lib/commands", and `@tauri-apps/api/core` is mocked
// per test (via `vi.doMock` + `vi.resetModules`) so `isTauri` evaluates
// `true` and the `invoke(...).catch(...)` branch under test actually runs —
// in jsdom there's no real Tauri bridge, so without this the module's
// `isTauri` is `false` and `terminalState` never reaches that branch at all.
describe("terminalState contract (commands.ts)", () => {
  afterEach(() => {
    vi.doUnmock("@tauri-apps/api/core");
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  async function loadRealCommandsWithInvoke(
    invokeImpl: (cmd: string, args?: unknown) => Promise<unknown>,
  ) {
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: invokeImpl }));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    return vi.importActual<typeof import("../../lib/commands")>("../../lib/commands");
  }

  it("resolves null for the exact 'no such terminal session' error", async () => {
    const real = await loadRealCommandsWithInvoke(async () => {
      // Tauri command errors arrive as a plain string, not an Error.
      throw "no such terminal session";
    });

    await expect(real.terminalState("p1")).resolves.toBeNull();
  });

  it("rejects for any other error instead of collapsing it to absence", async () => {
    const real = await loadRealCommandsWithInvoke(async () => {
      throw "terminal session panicked mid-write";
    });

    await expect(real.terminalState("p1")).rejects.toBeTruthy();
  });

  it("resolves the live TerminalState unchanged when the session exists", async () => {
    const state: TerminalState = { alive: true, running: true, pid: 42, exitCode: null };
    const real = await loadRealCommandsWithInvoke(async () => state);

    await expect(real.terminalState("p1")).resolves.toEqual(state);
  });
});

describe("closing a busy tab", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
    terminalClose.mockClear();
    confirmDialog.mockClear();
    confirmDialog.mockResolvedValue(true);
  });

  function seedRunning() {
    // Keep the focused-pane poll's own response consistent with the
    // "running" state seeded below — the file-level default resolves
    // `running: false`, and the poll's mount tick is already in flight by
    // the time this function returns, so leaving that default in place
    // would race the seeded state and clobber it back to "idle" before the
    // click below ever fires.
    terminalState.mockResolvedValue({ alive: true, running: true, pid: 1, exitCode: null } satisfies TerminalState);
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const tab = usePortaStore.getState().terminalTabs["a1"][0];
    act(() => {
      usePortaStore.getState().setTerminalPaneState("a1", tab.panes[0].id, { state: "running" });
    });
    return tab;
  }

  it("asks before killing a shell that is still working", async () => {
    seedRunning();
    await userEvent.click(screen.getByTitle("Close tab (⌘W)"));

    expect(confirmDialog).toHaveBeenCalled();
    await vi.waitFor(() => expect(terminalClose).toHaveBeenCalled());
  });

  it("leaves the session alone when the user declines", async () => {
    confirmDialog.mockResolvedValue(false);
    seedRunning();
    await userEvent.click(screen.getByTitle("Close tab (⌘W)"));

    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(terminalClose).not.toHaveBeenCalled();
  });

  it("closes an idle tab without asking", async () => {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    await userEvent.click(screen.getByTitle("Close tab (⌘W)"));

    expect(confirmDialog).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(terminalClose).toHaveBeenCalled());
  });

  // Finding 4: `tabState` (what decides whether to confirm) reads `pane.state`,
  // which used to only ever get written by the poll for the *focused* pane on
  // the *active* tab. A background tab's panes therefore stayed `idle` forever
  // regardless of what was actually running in them, so its close button
  // could kill a mid-build shell with no prompt at all — silently, since nothing
  // else about the tab looked any different from a genuinely idle one.
  it("still asks before closing a background tab that is actually running", async () => {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const foregroundTabId = usePortaStore.getState().terminalTabs["a1"][0].id;
    const foregroundPaneId = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;
    // Configured *before* the second pane exists — keying on the foreground
    // pane's already-known id rather than the not-yet-created background
    // one — so the very first poll tick to ever see the new pane (which the
    // paneCount-triggered effect re-run fires synchronously as part of the
    // `addTerminalTab` act() below, well before this test could otherwise
    // react to the new id) already reports it running, instead of racing a
    // separately-configured mock and losing.
    terminalState.mockImplementation((paneId: string) =>
      Promise.resolve(
        paneId === foregroundPaneId
          ? ({ alive: true, running: false, pid: 1, exitCode: null } satisfies TerminalState)
          : ({ alive: true, running: true, pid: 2, exitCode: null } satisfies TerminalState),
      ),
    );

    act(() => {
      usePortaStore.getState().addTerminalTab("a1", "porta", "/src/porta", null);
    });
    const bgPaneId = usePortaStore.getState().terminalTabs["a1"][1].panes[0].id;
    // The newly added tab became active; switch back so the running one is
    // the *background* tab under test.
    act(() => {
      usePortaStore.getState().setActiveTerminalTab("a1", foregroundTabId);
    });

    // Let the poll (which now covers every tab, not just the active one)
    // actually observe the background pane as running.
    await waitFor(() => {
      expect(
        usePortaStore.getState().terminalTabs["a1"][1].panes[0].state,
      ).toBe("running");
    });

    const closeButtons = screen.getAllByTitle("Close tab (⌘W)");
    await userEvent.click(closeButtons[1]);

    expect(confirmDialog).toHaveBeenCalled();
    await vi.waitFor(() => expect(terminalClose).toHaveBeenCalledWith(bgPaneId));
  });
});

describe("closing a busy pane", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
    terminalClose.mockClear();
    confirmDialog.mockClear();
    confirmDialog.mockResolvedValue(true);
  });

  // Split, then let the (now app-wide) poll itself observe pane 2 as running
  // — same reasoning as `seedRunning()` above: configuring the mock to key
  // on pane 1's already-known id, before pane 2 exists, means the first tick
  // to ever see pane 2 (fired synchronously off the paneCount-triggered
  // effect re-run inside the `splitTerminalTab` act() below) already reports
  // it running. Setting `pane.state` directly instead would race that same
  // tick, which polls unconditionally and would clobber a manually-set
  // "running" back to "idle" moments later.
  function seedSplitWithRunningSecondPane() {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const tabId = usePortaStore.getState().terminalTabs["a1"][0].id;
    const pane1Id = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;
    terminalState.mockImplementation((paneId: string) =>
      Promise.resolve(
        paneId === pane1Id
          ? ({ alive: true, running: false, pid: 1, exitCode: null } satisfies TerminalState)
          : ({ alive: true, running: true, pid: 2, exitCode: null } satisfies TerminalState),
      ),
    );
    act(() => {
      usePortaStore.getState().splitTerminalTab("a1", tabId, "cols");
    });
    const pane2Id = usePortaStore.getState().terminalTabs["a1"][0].panes[1].id;
    return pane2Id;
  }

  it("asks before closing a pane the poll knows is running", async () => {
    const pane2Id = seedSplitWithRunningSecondPane();
    await waitFor(() => {
      const pane2 = usePortaStore.getState().terminalTabs["a1"][0].panes.find((p) => p.id === pane2Id);
      expect(pane2?.state).toBe("running");
    });

    const closeButtons = screen.getAllByTitle("Close pane");
    await userEvent.click(closeButtons[1]);

    expect(confirmDialog).toHaveBeenCalled();
    await vi.waitFor(() => expect(terminalClose).toHaveBeenCalledWith(pane2Id));
  });

  it("leaves a running pane alone when the user declines", async () => {
    confirmDialog.mockResolvedValue(false);
    const pane2Id = seedSplitWithRunningSecondPane();
    await waitFor(() => {
      const pane2 = usePortaStore.getState().terminalTabs["a1"][0].panes.find((p) => p.id === pane2Id);
      expect(pane2?.state).toBe("running");
    });

    const closeButtons = screen.getAllByTitle("Close pane");
    await userEvent.click(closeButtons[1]);

    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(terminalClose).not.toHaveBeenCalled();
  });

  it("closes an idle pane without asking", async () => {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const tabId = usePortaStore.getState().terminalTabs["a1"][0].id;
    act(() => {
      usePortaStore.getState().splitTerminalTab("a1", tabId, "cols");
    });
    const [, pane2] = usePortaStore.getState().terminalTabs["a1"][0].panes;

    const closeButtons = screen.getAllByTitle("Close pane");
    await userEvent.click(closeButtons[1]);

    expect(confirmDialog).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(terminalClose).toHaveBeenCalledWith(pane2.id));
  });
});

// Finding 4: the poll used to cover only the focused pane. These pin that it
// now covers every pane of every tab for the app — a background tab's pane,
// and a non-focused pane in a split — which is what makes the confirmation
// tests above (and the tab-strip dot for a background tab) trustworthy.
describe("polling covers every pane, not just the focused one", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
    terminalState.mockReset();
    terminalState.mockResolvedValue({ alive: true, running: false, pid: 0, exitCode: null } satisfies TerminalState);
  });

  it("polls both panes of a split tab, not only the focused one", async () => {
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const tabId = usePortaStore.getState().terminalTabs["a1"][0].id;
    act(() => {
      usePortaStore.getState().splitTerminalTab("a1", tabId, "cols");
    });
    const [pane1, pane2] = usePortaStore.getState().terminalTabs["a1"][0].panes;

    // Cumulative since mount — the split fires an immediate tick over both
    // panes synchronously as part of the act() above, so no further waiting
    // is even strictly required, but waitFor keeps this robust either way.
    await waitFor(() => {
      const polled = terminalState.mock.calls.map((c) => c[0]);
      expect(polled).toContain(pane1.id);
      expect(polled).toContain(pane2.id);
    });
  });

  it("polls a background tab's pane on the ongoing cadence, not just transiently", async () => {
    vi.useFakeTimers();
    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const foregroundTabId = usePortaStore.getState().terminalTabs["a1"][0].id;
    act(() => {
      usePortaStore.getState().addTerminalTab("a1", "porta", "/src/porta", null);
    });
    const backgroundPaneId = usePortaStore.getState().terminalTabs["a1"][1].panes[0].id;
    // `addTerminalTab` makes the new tab active on creation, so switch back
    // — the tab under test must be genuinely in the background (not active)
    // for the whole window being measured below, not just transiently active
    // a moment ago (which even the single-focused-pane poll this replaces
    // would have covered once, coincidentally, while creating it).
    act(() => {
      usePortaStore.getState().setActiveTerminalTab("a1", foregroundTabId);
    });
    terminalState.mockClear();

    // Neither pane's id changed, so nothing here re-triggers the poll effect
    // itself — this only proves out its *ongoing* 2s cadence, deterministically,
    // rather than a real-time wait racing the interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });

    const polled = terminalState.mock.calls.map((c) => c[0]);
    expect(polled).toContain(backgroundPaneId);
    vi.useRealTimers();
  });
});

// ADDENDUM: TerminalModal never unmounts on close (just `display: none`), so
// a background app's TerminalWorkspace stays mounted and watching its own
// tabs. Once deleteApp calls closeAppTerminals (this task), deleting a
// background app empties that app's tab list — without the `active` guard,
// its onEmpty would fire and call setActiveTerminalAppId(null), closing
// whichever *other* terminal the user currently has open.
describe("reporting an empty surface", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
  });

  it("does not call onEmpty when an inactive surface's tabs are emptied from outside", async () => {
    const onEmpty = vi.fn();
    render(
      <TerminalWorkspace
        appId="a1"
        appName="porta"
        rootDir="/src/porta"
        active={false}
        onEmpty={onEmpty}
      />,
    );
    act(() => {
      usePortaStore.getState().addTerminalTab("a1", "porta", "/src/porta", null);
    });
    const tabId = usePortaStore.getState().terminalTabs["a1"][0].id;

    await act(async () => {
      await usePortaStore.getState().closeTerminalTab("a1", tabId);
    });

    expect(onEmpty).not.toHaveBeenCalled();
  });
});

// Finding 5: `deleteApp` used to close terminal sessions — which empties
// `terminalTabs[appId]` — *before* removing the app from `apps`. While the
// app was still in `apps`, the real app (App.tsx renders the workbench off
// `apps.find(...)`) would still have this component mounted, its autoSeed
// effect would see `tabs.length` drop to 0, and it would spawn a brand-new
// tab — and a real PTY — for an app that was mid-delete, one nothing would
// ever go on to close. `AppGatedMount` below reproduces that same
// apps-gated mount/unmount App.tsx actually uses, rather than asserting
// against an isolated TerminalWorkspace that (unlike production) never
// unmounts on its own.
function AppGatedMount({ appId }: { appId: string }) {
  const exists = usePortaStore((s) => s.apps.some((a) => a.id === appId));
  if (!exists) return null;
  return <TerminalWorkspace appId={appId} appName="porta" rootDir="/src/porta" active autoSeed />;
}

describe("app deletion does not re-seed the app it is deleting", () => {
  beforeEach(() => {
    usePortaStore.setState({
      terminalTabs: {},
      terminalActiveTab: {},
      apps: [{ id: "a1", name: "porta" } as any],
    });
    terminalClose.mockClear();
  });

  it("leaves the deleted app with no terminal tabs, not a freshly re-seeded one", async () => {
    render(<AppGatedMount appId="a1" />);
    await waitFor(() => expect(usePortaStore.getState().terminalTabs["a1"]).toHaveLength(1));

    await act(async () => {
      await usePortaStore.getState().deleteApp("a1");
    });

    expect(usePortaStore.getState().terminalTabs["a1"]).toBeUndefined();
    expect(usePortaStore.getState().apps.some((a) => a.id === "a1")).toBe(false);
  });

  // The test above only checks the state after `act` has settled — but
  // `deleteApp`'s `apps` filter and its `closeAppTerminals` await both run
  // inside the same `await act(async () => …)`, so nothing here ever
  // observes an intermediate render. Under the *old*, buggy ordering
  // (`closeAppTerminals` awaited before the `apps` filter — see the comment
  // above `deleteApp` in `store/slices/app.ts`), `terminalTabs["a1"]` would
  // empty out while `a1` was still in `apps`, this component would still be
  // mounted to see it, and its autoSeed effect would re-seed a fresh tab —
  // yet by the time `act` resolves, `apps` has since been filtered too, so
  // the final state above looks identical either way. Spying on
  // `ensureTerminalTab` — the call autoSeed makes to re-seed — is what
  // actually distinguishes the two orderings, regardless of what the last
  // render looks like.
  it("never re-seeds the app being deleted, even mid-delete", async () => {
    const ensureTerminalTabSpy = vi.fn(usePortaStore.getState().ensureTerminalTab);
    usePortaStore.setState({ ensureTerminalTab: ensureTerminalTabSpy });

    render(<AppGatedMount appId="a1" />);
    await waitFor(() => expect(usePortaStore.getState().terminalTabs["a1"]).toHaveLength(1));
    ensureTerminalTabSpy.mockClear(); // Drop the initial autoSeed call from mount.

    await act(async () => {
      await usePortaStore.getState().deleteApp("a1");
    });

    expect(ensureTerminalTabSpy).not.toHaveBeenCalled();
    expect(usePortaStore.getState().terminalTabs["a1"]).toBeUndefined();
    expect(usePortaStore.getState().apps.some((a) => a.id === "a1")).toBe(false);
  });
});
