import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
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

// Captured per pane id so tests can drive `onTranscriptStats` at will,
// independent of mount timing — a real TerminalTab reports stats from its
// xterm transcript, which this double doesn't have.
const paneProps = vi.hoisted(
  () => new Map<string, { onTranscriptStats?: (lineCount: number, matchCount: number | null) => void }>(),
);

// xterm paints to a canvas jsdom can't render; the tab strip is what's under test.
vi.mock("./TerminalTab", () => ({
  default: (props: { appId: string; onTranscriptStats?: (lineCount: number, matchCount: number | null) => void }) => {
    paneProps.set(props.appId, props);
    // Runs once per mount *and* once per remount (a `key` change forces a
    // fresh instance) — nothing else in this double depends on appId.
    useEffect(() => () => { paneProps.delete(props.appId); }, [props.appId]);
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

  // Finding 1's bound: a session that never shows up (terminalOpen itself
  // failed) shouldn't poll forever reporting nothing — past a threshold of
  // consecutive "no record" responses, the pane is surfaced as exited so
  // Restart is available instead of a silent, permanently "idle" dead end.
  it("gives up and surfaces Restart after the session stays absent past the bound", async () => {
    vi.useFakeTimers();
    terminalState.mockResolvedValue(null);

    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const paneId = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    const pane = usePortaStore.getState().terminalTabs["a1"][0].panes.find((p) => p.id === paneId)!;
    expect(pane.state).toBe("exited");
  });
});

describe("restartFocusedPane", () => {
  beforeEach(() => {
    usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
    terminalClose.mockClear();
  });

  it("closes the session, resets the pane to idle, drops its transcript stats, and remounts the pane", async () => {
    // Isolate the restart's own store writes from the poll's: a real poll
    // tick landing after the reset would (correctly) overwrite `pid: null`
    // with whatever pid the freshly reopened shell reports, which is exactly
    // the right behavior in the app but would race this assertion.
    terminalState.mockImplementation(() => new Promise(() => {}));

    render(<TerminalWorkspace appId="a1" appName="porta" rootDir="/src/porta" active autoSeed />);
    const paneId = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    act(() => {
      paneProps.get(paneId)?.onTranscriptStats?.(7, null);
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
});
