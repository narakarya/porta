import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { usePortaStore } from "../../store";
import UpdateToast from "./UpdateToast";

// The toast's actions call into the native updater; the point here is what the
// card says, not what the plugin does.
vi.mock("../../lib/updater", () => ({
  dismissUpdater: vi.fn(),
  restartForUpdate: vi.fn(),
  startUpdateDownload: vi.fn(),
  checkForUpdate: vi.fn(),
}));

describe("UpdateToast", () => {
  beforeEach(() => {
    usePortaStore.setState({
      updaterPhase: "idle",
      updaterInfo: null,
      updaterError: null,
      updaterCheckSource: "menu",
    });
  });

  it("reads as neutral, not failed, when the manifest is unreachable", () => {
    usePortaStore.setState({ updaterPhase: "unavailable" });
    const { container } = render(<UpdateToast />);

    expect(screen.getByText("No update available yet")).toBeInTheDocument();
    expect(screen.queryByText("Update failed")).not.toBeInTheDocument();
    // No plugin internals leak into the copy.
    expect(screen.queryByText(/release JSON/i)).not.toBeInTheDocument();
    // The red status dot belongs to genuine failures only.
    expect(container.querySelector(".bg-bad")).toBeNull();
    // Retry is the one useful affordance.
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("still shows a real failure in red with its message", () => {
    usePortaStore.setState({
      updaterPhase: "error",
      updaterError: "signature verification failed",
    });
    const { container } = render(<UpdateToast />);

    expect(screen.getByText("Update failed")).toBeInTheDocument();
    expect(screen.getByText("signature verification failed")).toBeInTheDocument();
    expect(container.querySelector(".bg-bad")).not.toBeNull();
  });
});
