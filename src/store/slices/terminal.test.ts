import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePortaStore } from "../index";

const terminalClose = vi.hoisted(() => vi.fn(async (_paneId: string) => {}));
vi.mock("../../lib/commands", async (orig) => ({
  ...(await orig<typeof import("../../lib/commands")>()),
  terminalClose,
}));

function reset() {
  usePortaStore.setState({ terminalTabs: {}, terminalActiveTab: {} });
  terminalClose.mockClear();
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

  it("closes every session an app owns when the app is deleted", async () => {
    usePortaStore.getState().ensureTerminalTab("a1", "porta", "/src/porta");
    usePortaStore.getState().ensureTerminalTab("a2", "smartuq", "/src/smartuq");
    const doomed = usePortaStore.getState().terminalTabs["a1"][0].panes[0].id;

    await usePortaStore.getState().closeAppTerminals("a1");

    expect(terminalClose).toHaveBeenCalledWith(doomed);
    expect(usePortaStore.getState().terminalTabs["a1"]).toBeUndefined();
    expect(usePortaStore.getState().terminalTabs["a2"]).toHaveLength(1);
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
