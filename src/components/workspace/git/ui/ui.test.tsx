import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FilterBox from "./FilterBox";
import { markMatches } from "./markMatches";
import FacetChips from "./FacetChips";
import ActivePane, { useActivePane } from "./ActivePane";
import { useContextMenu, type ContextMenuItem } from "./useContextMenu";

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

describe("markMatches", () => {
  function Marked({ text, query }: { text: string; query: string }) {
    return <span data-testid="marked">{markMatches(text, query)}</span>;
  }
  const node = () => screen.getByTestId("marked");

  it("returns the text untouched when there is nothing to match", () => {
    render(<Marked text="src/one.ts" query="   " />);
    expect(node().textContent).toBe("src/one.ts");
    expect(node().querySelector("mark")).toBeNull();
  });

  it("marks every occurrence, case-insensitively, without altering the text", () => {
    render(<Marked text="src/Sub/sample.ts" query="s" />);
    expect(node().textContent).toBe("src/Sub/sample.ts");
    const marks = [...node().querySelectorAll("mark")].map((m) => m.textContent);
    // Original casing is preserved inside the mark — the query is only a probe.
    expect(marks).toEqual(["s", "S", "s", "s"]);
  });

  it("colours the mark through palette tokens only", () => {
    render(<Marked text="gizmo.ts" query="z" />);
    const mark = node().querySelector("mark")!;
    // A bare <mark> is UA-yellow-on-black, which belongs to no palette.
    expect(mark.className).toContain("bg-warn-bg");
    expect(mark.className).toContain("text-warn");
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


/**
 * The consumer the old wrapper API could not serve: the row *is* a `<tr>`, so
 * any element injected around it would be illegal inside a `<tbody>`. The hook
 * hands back a prop instead, so the row stays the tbody's direct child and the
 * menu renders as a sibling of the table.
 */
function TableRow({ items }: { items: ContextMenuItem[] }) {
  const { onContextMenu, menu } = useContextMenu(items);
  return (
    <>
      <table>
        <tbody>
          <tr onContextMenu={onContextMenu}>
            <td>row</td>
          </tr>
        </tbody>
      </table>
      {menu}
    </>
  );
}

describe("useContextMenu", () => {
  it("imposes no element of its own on the row", () => {
    render(<TableRow items={[{ id: "copy", label: "Copy path", onSelect: vi.fn() }]} />);
    const cell = screen.getByText("row");
    expect(cell.tagName).toBe("TD");
    expect(cell.parentElement?.tagName).toBe("TR");
    expect(cell.parentElement?.parentElement?.tagName).toBe("TBODY");
  });

  it("opens on right-click and runs the chosen item", async () => {
    const onSelect = vi.fn();
    render(<TableRow items={[{ id: "copy", label: "Copy path", onSelect }]} />);
    expect(screen.queryByText("Copy path")).toBeNull();
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("row") });
    await userEvent.click(screen.getByText("Copy path"));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("closes on Escape without running anything", async () => {
    const onSelect = vi.fn();
    render(<TableRow items={[{ id: "copy", label: "Copy path", onSelect }]} />);
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("row") });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("Copy path")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes on a click outside the menu without running anything", async () => {
    const onSelect = vi.fn();
    render(<TableRow items={[{ id: "copy", label: "Copy path", onSelect }]} />);
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("row") });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Copy path")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("takes its global listeners back down when it unmounts while open", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const { unmount } = render(
        <TableRow items={[{ id: "copy", label: "Copy path", onSelect: vi.fn() }]} />,
      );
      await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("row") });
      const count = (spy: typeof add, type: string) =>
        spy.mock.calls.filter((c) => c[0] === type).length;
      expect(count(add, "keydown")).toBeGreaterThan(0);
      unmount();
      expect(count(remove, "keydown")).toBe(count(add, "keydown"));
      expect(count(remove, "mousedown")).toBe(count(add, "mousedown"));
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  describe("viewport clamping", () => {
    // jsdom always reports a zero-size getBoundingClientRect, which leaves the
    // clamping branch in the hook's useLayoutEffect permanently inert. Stub a
    // realistic menu size and viewport so the clamp path actually runs.
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
      render(<TableRow items={[{ id: "copy", label: "Copy path", onSelect: vi.fn() }]} />);

      fireEvent.contextMenu(screen.getByText("row"), { clientX: 780, clientY: 580 });

      const menu = screen.getByRole("menu");
      // x + width(200) > innerWidth(800) - margin(4) -> clamped to 800-200-4
      expect(menu.style.left).toBe("596px");
      // y + height(150) > innerHeight(600) - margin(4) -> clamped to 600-150-4
      expect(menu.style.top).toBe("446px");
    });

    it("does not clamp a click in open space", () => {
      stubViewport();
      render(<TableRow items={[{ id: "copy", label: "Copy path", onSelect: vi.fn() }]} />);

      fireEvent.contextMenu(screen.getByText("row"), { clientX: 100, clientY: 100 });

      const menu = screen.getByRole("menu");
      expect(menu.style.left).toBe("100px");
      expect(menu.style.top).toBe("100px");
    });
  });
});

/**
 * The gate the kept-mounted panes read. Its whole job is to make "hidden" and
 * "unmounted" two different things, so both are asserted here.
 */
describe("ActivePane", () => {
  let probeMounts = 0;
  function Probe() {
    const active = useActivePane();
    useEffect(() => { probeMounts += 1; }, []);
    return <span>pane is {active ? "active" : "idle"}</span>;
  }

  function Toggling() {
    const [active, setActive] = useState(true);
    return (
      <>
        <button onClick={() => setActive((v) => !v)}>toggle</button>
        <ActivePane active={active} className="flex-1">
          <Probe />
        </ActivePane>
      </>
    );
  }

  beforeEach(() => { probeMounts = 0; });

  // Seven of the eight tabs mount on demand and never sit in a pane slot; they
  // must not have to opt in to keep working.
  it("reads as active with no pane above it", () => {
    render(<Probe />);
    expect(screen.getByText(/pane is active/)).toBeInTheDocument();
  });

  it("hides its child and tells it so — without unmounting it", async () => {
    render(<Toggling />);
    expect(probeMounts).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "toggle" }));
    const probe = screen.getByText(/pane is idle/);
    expect(probe).not.toBeVisible();
    expect(probe.closest("div")).toHaveAttribute("hidden");
    expect(probeMounts).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.getByText(/pane is active/)).toBeVisible();
    expect(probeMounts).toBe(1);
  });
});
