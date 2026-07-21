import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FilterBox from "./FilterBox";
import FacetChips from "./FacetChips";
import ContextMenu from "./ContextMenu";

describe("FilterBox", () => {
  it("reports each keystroke without losing focus", async () => {
    const onChange = vi.fn();
    render(<FilterBox value="" onChange={onChange} placeholder="Filter branches…" />);
    const input = screen.getByPlaceholderText("Filter branches…");
    await userEvent.type(input, "ma");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(input).toHaveFocus();
  });
});

describe("FacetChips", () => {
  const facets = [
    { id: "all", label: "All", count: 12 },
    { id: "merged", label: "Merged", count: 3 },
  ];

  it("marks the active facet as pressed", () => {
    render(<FacetChips facets={facets} active="merged" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Merged/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /All/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows counts and reports selection", async () => {
    const onSelect = vi.fn();
    render(<FacetChips facets={facets} active="all" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: /Merged/ })).toHaveTextContent("3");
    await userEvent.click(screen.getByRole("button", { name: /Merged/ }));
    expect(onSelect).toHaveBeenCalledWith("merged");
  });
});

describe("ContextMenu", () => {
  it("opens on right-click and runs the chosen item", async () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu items={[{ id: "copy", label: "Copy path", onSelect }]}>
        <div>row</div>
      </ContextMenu>,
    );
    expect(screen.queryByText("Copy path")).toBeNull();
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("row") });
    await userEvent.click(screen.getByText("Copy path"));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("closes on Escape without running anything", async () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu items={[{ id: "copy", label: "Copy path", onSelect }]}>
        <div>row</div>
      </ContextMenu>,
    );
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("row") });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("Copy path")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
