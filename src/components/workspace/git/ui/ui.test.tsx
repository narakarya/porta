import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  describe("viewport clamping", () => {
    // jsdom always reports a zero-size getBoundingClientRect, which leaves the
    // clamping branch in ContextMenu's useLayoutEffect permanently inert. Stub
    // a realistic menu size and viewport so the clamp path actually runs.
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;

    afterEach(() => {
      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: originalInnerHeight, configurable: true });
    });

    function stubViewport() {
      Element.prototype.getBoundingClientRect = () =>
        ({
          width: 200,
          height: 150,
          top: 0,
          left: 0,
          right: 200,
          bottom: 150,
          x: 0,
          y: 0,
          toJSON() {},
        }) as DOMRect;
      Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    }

    it("clamps the menu back inside the viewport near the bottom-right corner", () => {
      stubViewport();
      render(
        <ContextMenu items={[{ id: "copy", label: "Copy path", onSelect: vi.fn() }]}>
          <div>row</div>
        </ContextMenu>,
      );

      fireEvent.contextMenu(screen.getByText("row"), { clientX: 780, clientY: 580 });

      const menu = screen.getByRole("menu");
      // x + width(200) > innerWidth(800) - margin(4) -> clamped to 800-200-4
      expect(menu.style.left).toBe("596px");
      // y + height(150) > innerHeight(600) - margin(4) -> clamped to 600-150-4
      expect(menu.style.top).toBe("446px");
    });

    it("does not clamp a click in open space", () => {
      stubViewport();
      render(
        <ContextMenu items={[{ id: "copy", label: "Copy path", onSelect: vi.fn() }]}>
          <div>row</div>
        </ContextMenu>,
      );

      fireEvent.contextMenu(screen.getByText("row"), { clientX: 100, clientY: 100 });

      const menu = screen.getByRole("menu");
      expect(menu.style.left).toBe("100px");
      expect(menu.style.top).toBe("100px");
    });
  });
});
