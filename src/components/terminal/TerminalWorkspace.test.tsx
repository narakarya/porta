import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { usePortaStore } from "../../store";
import TerminalWorkspace from "./TerminalWorkspace";

const terminalClose = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/commands", async (orig) => ({
  ...(await orig<typeof import("../../lib/commands")>()),
  terminalClose,
}));

// xterm paints to a canvas jsdom can't render; the tab strip is what's under test.
vi.mock("./TerminalTab", () => ({
  default: ({ appId }: { appId: string }) => <div data-testid={`pane-${appId}`} />,
}));

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
