import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePortaStore } from "../../store";
import Notices from "./Notices";

describe("Notices", () => {
  beforeEach(() => usePortaStore.setState({ notices: [] }));

  it("renders nothing when there is nothing to say", () => {
    const { container } = render(<Notices />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the headline and the backend detail", () => {
    usePortaStore
      .getState()
      .notify({ kind: "error", message: "Failed to start web", detail: "bind: address in use" });
    render(<Notices />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Failed to start web")).toBeInTheDocument();
    expect(screen.getByText("bind: address in use")).toBeInTheDocument();
  });

  it("can be dismissed", async () => {
    usePortaStore.getState().notify({ kind: "error", message: "boom" });
    render(<Notices />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(usePortaStore.getState().notices).toHaveLength(0);
  });
});
