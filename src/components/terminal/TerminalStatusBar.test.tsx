import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TerminalStatusBar from "./TerminalStatusBar";
import type { PaneSession } from "../../store/slices/terminal";

function pane(over: Partial<PaneSession> = {}): PaneSession {
  return {
    id: "p1", rootDir: "/src/porta", startupCommand: null, hasUnseenOutput: false,
    state: "idle", exitCode: null, pid: 4242, ...over,
  };
}

describe("TerminalStatusBar", () => {
  it("shows an idle shell with its pid", () => {
    render(<TerminalStatusBar pane={pane()} lineCount={12} matchCount={null} onRestart={() => {}} />);
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("pid 4242")).toBeInTheDocument();
    expect(screen.getByText("12 lines")).toBeInTheDocument();
  });

  it("shows the exit code when the shell died", () => {
    render(<TerminalStatusBar pane={pane({ state: "exited", exitCode: 1 })} lineCount={0} matchCount={null} onRestart={() => {}} />);
    expect(screen.getByText("exited (1)")).toBeInTheDocument();
  });

  it("offers restart only for an exited shell", async () => {
    const onRestart = vi.fn();
    const { rerender } = render(
      <TerminalStatusBar pane={pane()} lineCount={0} matchCount={null} onRestart={onRestart} />,
    );
    expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();

    rerender(<TerminalStatusBar pane={pane({ state: "exited", exitCode: 0 })} lineCount={0} matchCount={null} onRestart={onRestart} />);
    await userEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(onRestart).toHaveBeenCalled();
  });

  it("reports match counts while a search is active", () => {
    render(<TerminalStatusBar pane={pane()} lineCount={900} matchCount={3} onRestart={() => {}} />);
    expect(screen.getByText("3 matches")).toBeInTheDocument();
  });

  it("renders nothing without a pane", () => {
    const { container } = render(
      <TerminalStatusBar pane={null} lineCount={0} matchCount={null} onRestart={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
