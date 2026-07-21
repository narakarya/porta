import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePortaStore } from "../index";

const terminalClose = vi.hoisted(() => vi.fn(async (_paneId: string) => {}));
const deleteApp = vi.hoisted(() => vi.fn(async (_id: string) => {}));
vi.mock("../../lib/commands", async (orig) => ({
  ...(await orig<typeof import("../../lib/commands")>()),
  terminalClose,
  deleteApp,
}));

function reset() {
  usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {}, apps: [] });
  terminalClose.mockClear();
  deleteApp.mockClear();
}

describe("terminal tabs are scoped per app", () => {
  beforeEach(reset);

  it("seeds one tab the first time an app's terminal is opened", () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");

    const tabs = usePortaStore.getState().terminalTabs["a1"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].panes).toHaveLength(1);
    expect(tabs[0].rootDir).toBe("/src/porta");
    expect(usePortaStore.getState().terminalActiveTab["a1"]).toBe(tabs[0].id);
  });

  it("does not reseed an app that already has tabs", () => {
    const { ensureTerminalTab } = usePortaStore.getState();
    ensureTerminalTab("a1", "porta", "/src/porta");
    const first = usePortaStore.getState().terminalTabs["a1"][0].id;
    ensureTerminalTab("a1", "porta", "/src/porta");

    expect(usePortaStore.getState().terminalTabs["a1"]).toHaveLength(1);
    expect(usePortaStore.getState().terminalTabs["a1"][0].id).toBe(first);
  });

  // The reported bug: app A's tabs stayed on screen while app B was selected.
  it("keeps each app's tabs separate", () => {
    const { ensureTerminalTab } = usePortaStore.getState();
    ensureTerminalTab("a1", "porta", "/src/porta");
    ensureTerminalTab("a2", "smartuq", "/src/smartuq");

    const { terminalTabs } = usePortaStore.getState();
    expect(terminalTabs["a1"][0].rootDir).toBe("/src/porta");
    expect(terminalTabs["a2"][0].rootDir).toBe("/src/smartuq");
    expect(terminalTabs["a1"][0].id).not.toBe(terminalTabs["a2"][0].id);
  });

  it("labels a tab by its startup command, not the app name", () => {
    usePortaStore.getState().addTerminalTab("a1", "porta", "/src/porta", "npm run dev");
    const tabs = usePortaStore.getState().terminalTabs["a1"];
    expect(tabs[tabs.length - 1].label).toBe("npm run dev");
  });

  it("labels a plain tab zsh", () => {
    usePortaStore.getState().addTerminalTab("a1", "porta", "/src/porta", null);
    const tabs = usePortaStore.getState().terminalTabs["a1"];
    expect(tabs[tabs.length - 1].label).toBe("zsh");
  });

  // The by-value isolation test above can't catch aliasing — two apps
  // accidentally sharing the same array reference would still pass it as
  // long as the values happened to differ. Assert identity too.
  it("leaves another app's tab array reference untouched when one app is mutated", () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    usePortaStore.getState().ensureTerminalTab("a2", "smartuq", "/src/smartuq");
    const before = usePortaStore.getState().terminalTabs["a2"];

    usePortaStore.getState().addTerminalTab("a1", "porta", "/src/porta", null);

    const after = usePortaStore.getState().terminalTabs["a2"];
    expect(before).toBe(after);
  });
});

describe("renaming and splitting tabs", () => {
  beforeEach(reset);

  it("renames a tab, trimming whitespace", () => {
    usePortaStore.getState().addTerminalTab("a1", "porta", "/src/porta", null);
    const tab = usePortaStore.getState().terminalTabs["a1"][0];

    usePortaStore.getState().renameTerminalTab("a1", tab.id, "  build  ");

    expect(usePortaStore.getState().terminalTabs["a1"][0].label).toBe("build");
  });

  it("keeps the previous label when renamed to a blank string", () => {
    usePortaStore.getState().addTerminalTab("a1", "porta", "/src/porta", null);
    const tab = usePortaStore.getState().terminalTabs["a1"][0];
    const original = tab.label;

    usePortaStore.getState().renameTerminalTab("a1", tab.id, "   ");

    expect(usePortaStore.getState().terminalTabs["a1"][0].label).toBe(original);
  });

  it("splitting an unsplit tab adds a second pane in the requested orientation", () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    const tab = usePortaStore.getState().terminalTabs["a1"][0];

    usePortaStore.getState().splitTerminalTab("a1", tab.id, "cols");

    const result = usePortaStore.getState().terminalTabs["a1"][0];
    expect(result.panes).toHaveLength(2);
    expect(result.splitOrientation).toBe("cols");
  });

  it("splitting an already-split tab flips orientation instead of adding a third pane", () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    const tab = usePortaStore.getState().terminalTabs["a1"][0];
    usePortaStore.getState().splitTerminalTab("a1", tab.id, "cols");
    const panesAfterFirstSplit = usePortaStore.getState().terminalTabs["a1"][0].panes;
    expect(panesAfterFirstSplit).toHaveLength(2);

    usePortaStore.getState().splitTerminalTab("a1", tab.id, "rows");

    const result = usePortaStore.getState().terminalTabs["a1"][0];
    expect(result.panes).toHaveLength(2);
    expect(result.panes.map((p) => p.id)).toEqual(panesAfterFirstSplit.map((p) => p.id));
    expect(result.splitOrientation).toBe("rows");
  });
});

describe("selecting the active tab", () => {
  beforeEach(reset);

  it("ignores a stale tab id instead of installing a dangling active tab", () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    const before = usePortaStore.getState().terminalActiveTab["a1"];

    usePortaStore.getState().setActiveTerminalTab("a1", "tab-does-not-exist");

    expect(usePortaStore.getState().terminalActiveTab["a1"]).toBe(before);
  });
});

describe("closing terminal surfaces", () => {
  beforeEach(reset);

  it("kills every pane's PTY when a tab closes", async () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    const tab = usePortaStore.getState().terminalTabs["a1"][0];
    usePortaStore.getState().splitTerminalTab("a1", tab.id, "cols");
    const paneIds = usePortaStore.getState().terminalTabs["a1"][0].panes.map((p) => p.id);

    await usePortaStore.getState().closeTerminalTab("a1", tab.id);

    expect(terminalClose.mock.calls.map((c) => c[0]).sort()).toEqual([...paneIds].sort());
  });

  it("selects the previous tab when the active one closes", async () => {
    const { addTerminalTab, closeTerminalTab } = usePortaStore.getState();
    addTerminalTab("a1", "porta", "/src/porta", null);
    addTerminalTab("a1", "porta", "/src/porta", null);
    const [first, second] = usePortaStore.getState().terminalTabs["a1"];

    await closeTerminalTab("a1", second.id);

    expect(usePortaStore.getState().terminalActiveTab["a1"]).toBe(first.id);
  });

  // Reseeding is the host's call, not the slice's — the modal closes on empty
  // while the workbench tab seeds a fresh shell. The slice just empties.
  it("leaves the app with no tabs when the last one closes", async () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    const only = usePortaStore.getState().terminalTabs["a1"][0];

    await usePortaStore.getState().closeTerminalTab("a1", only.id);

    expect(usePortaStore.getState().terminalTabs["a1"]).toEqual([]);
    expect(usePortaStore.getState().terminalActiveTab["a1"]).toBeNull();
  });

  it("closing the last pane closes the whole tab", async () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    const tab = usePortaStore.getState().terminalTabs["a1"];
    const pane = tab[0].panes[0].id;

    await usePortaStore.getState().closeTerminalPane("a1", tab[0].id, pane);

    expect(terminalClose).toHaveBeenCalledWith(pane);
    expect(usePortaStore.getState().terminalTabs["a1"]).toEqual([]);
  });

  it("closing one of several panes removes only that pane and keeps the tab", async () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    const tab = usePortaStore.getState().terminalTabs["a1"][0];
    usePortaStore.getState().splitTerminalTab("a1", tab.id, "cols");
    const [paneA, paneB] = usePortaStore.getState().terminalTabs["a1"][0].panes;

    await usePortaStore.getState().closeTerminalPane("a1", tab.id, paneA.id);

    expect(terminalClose).toHaveBeenCalledTimes(1);
    expect(terminalClose).toHaveBeenCalledWith(paneA.id);

    const tabs = usePortaStore.getState().terminalTabs["a1"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].panes.map((p) => p.id)).toEqual([paneB.id]);
  });

  it("closes every session an app owns when the app is deleted", async () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    usePortaStore.getState().ensureTerminalTab("a2", "smartuq", "/src/smartuq");
    const doomed = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    await usePortaStore.getState().closeAppTerminals("a1");

    expect(terminalClose).toHaveBeenCalledWith(doomed);
    expect(usePortaStore.getState().terminalTabs["a1"]).toBeUndefined();
    expect(usePortaStore.getState().terminalTabs["a2"]).toHaveLength(1);
  });

  // Regression, same shape as Finding 1: closeAppTerminals used to snapshot
  // its panes before awaiting terminalClose, then delete the app's key
  // outright. A tab added mid-teardown had its key deleted with no
  // terminalClose ever sent for it — a leaked shell.
  it("closes a pane added during closeAppTerminals's await window before deleting the app", async () => {
    const { addTerminalTab, closeAppTerminals } = usePortaStore.getState();
    addTerminalTab("a1", "porta", "/src/porta", null);

    let releaseClose: () => void = () => {};
    terminalClose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );

    const teardown = closeAppTerminals("a1");

    // Simulate a tab appearing while the first close round is in flight.
    const addedId = usePortaStore.getState().addTerminalTab("a1", "porta", "/src/porta", null);
    const addedPaneId = usePortaStore.getState().terminalTabs["a1"].find((t) => t.id === addedId)!
      .panes[0].id;

    releaseClose();
    await teardown;

    expect(terminalClose.mock.calls.map((c) => c[0])).toContain(addedPaneId);
    expect(usePortaStore.getState().terminalTabs["a1"]).toBeUndefined();
  });

  // Regression: closeTerminalTab used to snapshot `tabs` before awaiting
  // terminalClose, then write that stale array wholesale into state. A tab
  // added mid-close (user clicks "+" while the close IPC round-trips) was
  // silently dropped, while terminalActiveTab kept pointing at it — a
  // dangling active id with a spawned PTY nothing could reach to close.
  it("keeps a tab added during a slow close's await window", async () => {
    const { addTerminalTab, closeTerminalTab } = usePortaStore.getState();
    const closingId = addTerminalTab("a1", "porta", "/src/porta", null);

    let releaseClose: () => void = () => {};
    terminalClose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );

    const closePromise = closeTerminalTab("a1", closingId);

    // Simulate the user clicking "+" while the close is still in flight.
    const addedId = usePortaStore.getState().addTerminalTab("a1", "porta", "/src/porta", null);

    releaseClose();
    await closePromise;

    const tabs = usePortaStore.getState().terminalTabs["a1"];
    expect(tabs.map((t) => t.id)).toEqual([addedId]);

    const activeId = usePortaStore.getState().terminalActiveTab["a1"];
    expect(tabs.some((t) => t.id === activeId)).toBe(true);
  });
});

describe("app deletion", () => {
  beforeEach(reset);

  it("takes the app's terminal sessions with it", async () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    const pane = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    await usePortaStore.getState().closeAppTerminals("a1");

    expect(terminalClose).toHaveBeenCalledWith(pane);
  });

  // Finding 5: this test used to pin `terminalClose` firing *before*
  // `cmd.deleteApp` — that ordering is exactly what caused the bug. Closing
  // terminal sessions empties `terminalTabs[id]`, and if the app were still
  // in `apps` at that moment, TerminalWorkspace's autoSeed effect (keyed on
  // `tabs.length` going to 0) would re-seed a fresh tab — and spawn a real
  // PTY — for an app that's mid-delete, one nothing would ever go on to
  // close. The invariant that actually matters is `apps` losing this id
  // *before* any session gets closed, which is what stops that re-seed from
  // ever being possible, regardless of which IPC call happens to land first.
  it("removes the app from `apps` before closing its terminal sessions, so nothing can re-seed a tab for it", async () => {
    usePortaStore.setState({
      apps: [{ id: "a1", name: "porta" } as any],
    });
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    const paneId = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    let appsStillHadItWhenClosed: boolean | null = null;
    terminalClose.mockImplementationOnce(async (_paneId: string) => {
      appsStillHadItWhenClosed = usePortaStore.getState().apps.some((a) => a.id === "a1");
    });

    await usePortaStore.getState().deleteApp("a1");

    // Both still get called — this isn't about skipping either step.
    expect(terminalClose).toHaveBeenCalledWith(paneId);
    expect(deleteApp).toHaveBeenCalledWith("a1");

    // The pinned invariant: by the time this pane's session actually closes,
    // `apps` must already lack the app. `appsStillHadItWhenClosed` staying
    // `null` (rather than becoming `false`) is what this assertion would
    // catch if `closeAppTerminals` were dropped from `deleteApp` entirely —
    // `terminalClose` would never fire, the mock body above would never run,
    // and this fails on `null !== false` instead of a false positive.
    expect(appsStillHadItWhenClosed).toBe(false);
    expect(usePortaStore.getState().apps.some((a) => a.id === "a1")).toBe(false);
  });
});

describe("pane state", () => {
  beforeEach(reset);

  it("records liveness against the right pane", () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    const pane = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    usePortaStore.getState().setTerminalPaneState("a1", pane, { state: "running", pid: 4242 });

    const p = usePortaStore.getState().terminalTabs["a1"][0].panes[0];
    expect(p.state).toBe("running");
    expect(p.pid).toBe(4242);
  });

  // Finding C: the poll now covers every pane on a ~2s cadence, so a patch
  // that changes nothing is the common case, not the rare one. Manufacturing
  // a fresh pane/tab/array identity on every such tick means every consumer
  // downstream of `terminalTabs[appId]` — including memoized ones — re-derives
  // for no reason, forever.
  it("returns the same pane/tab/array identities when the patch changes nothing", () => {
    const { addTerminalTab, setTerminalPaneState } = usePortaStore.getState();
    addTerminalTab("a1", "porta", "/src/porta", null);
    const pane = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;
    setTerminalPaneState("a1", pane, { state: "running", pid: 4242 });

    const tabsBefore = usePortaStore.getState().terminalTabs["a1"];
    const paneBefore = tabsBefore[0].panes[0];

    // Same values the pane already has — a real repeat of what the poll
    // sends every tick once nothing has changed.
    setTerminalPaneState("a1", pane, { state: "running", exitCode: null, pid: 4242 });

    const tabsAfter = usePortaStore.getState().terminalTabs["a1"];
    expect(tabsAfter).toBe(tabsBefore);
    expect(tabsAfter[0]).toBe(tabsBefore[0]);
    expect(tabsAfter[0].panes[0]).toBe(paneBefore);
  });

  it("preserves object identity for tabs that don't contain the target pane", () => {
    const { addTerminalTab, setTerminalPaneState } = usePortaStore.getState();
    addTerminalTab("a1", "porta", "/src/porta", null);
    addTerminalTab("a1", "porta", "/src/porta", null);
    const [untouched, target] = usePortaStore.getState().terminalTabs["a1"];

    setTerminalPaneState("a1", target.panes[0].id, { state: "running", pid: 1 });

    const tabs = usePortaStore.getState().terminalTabs["a1"];
    expect(tabs[0]).toBe(untouched);
    expect(tabs[1]).not.toBe(target);
  });

  it("flags unseen output only on tabs that aren't active", () => {
    const { addTerminalTab, markTerminalPaneOutput } = usePortaStore.getState();
    addTerminalTab("a1", "porta", "/src/porta", null);
    addTerminalTab("a1", "porta", "/src/porta", null);
    const [background, active] = usePortaStore.getState().terminalTabs["a1"];

    markTerminalPaneOutput("a1", background.id, background.panes[0].id);
    markTerminalPaneOutput("a1", active.id, active.panes[0].id);

    const tabs = usePortaStore.getState().terminalTabs["a1"];
    expect(tabs[0].panes[0].hasUnseenOutput).toBe(true);
    expect(tabs[1].panes[0].hasUnseenOutput).toBe(false);
  });

  it("clears unseen output when its tab is selected", () => {
    const { addTerminalTab, markTerminalPaneOutput, setActiveTerminalTab } = usePortaStore.getState();
    addTerminalTab("a1", "porta", "/src/porta", null);
    addTerminalTab("a1", "porta", "/src/porta", null);
    const [background] = usePortaStore.getState().terminalTabs["a1"];
    markTerminalPaneOutput("a1", background.id, background.panes[0].id);

    setActiveTerminalTab("a1", background.id);

    expect(usePortaStore.getState().terminalTabs["a1"][0].panes[0].hasUnseenOutput).toBe(false);
  });
});
