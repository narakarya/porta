import { describe, it, expect, beforeEach } from "vitest";
import { usePortaStore } from "../index";
import { MAX_PINNED_EXTENSIONS, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from "./ui";

describe("pinned extensions", () => {
  beforeEach(() => usePortaStore.setState({ pinnedExtensions: [] }));

  it("pins in click order", () => {
    const { togglePinnedExtension } = usePortaStore.getState();
    togglePinnedExtension("kamal");
    togglePinnedExtension("git-manager");
    expect(usePortaStore.getState().pinnedExtensions).toEqual(["kamal", "git-manager"]);
  });

  it("refuses to pin past the cap instead of evicting a pin", () => {
    const { togglePinnedExtension } = usePortaStore.getState();
    togglePinnedExtension("a");
    togglePinnedExtension("b");
    togglePinnedExtension("c");
    const pinned = usePortaStore.getState().pinnedExtensions;
    expect(pinned).toHaveLength(MAX_PINNED_EXTENSIONS);
    expect(pinned).not.toContain("c");
  });

  it("unpins and frees a slot", () => {
    const { togglePinnedExtension } = usePortaStore.getState();
    togglePinnedExtension("a");
    togglePinnedExtension("b");
    togglePinnedExtension("a");
    togglePinnedExtension("c");
    expect(usePortaStore.getState().pinnedExtensions).toEqual(["b", "c"]);
  });

  it("persists to localStorage", () => {
    usePortaStore.getState().togglePinnedExtension("kamal");
    expect(JSON.parse(localStorage.getItem("porta.workbench.pinnedExtensions")!)).toEqual(["kamal"]);
  });
});

describe("sidebar width", () => {
  it("clamps a drag that would collapse the sidebar", () => {
    usePortaStore.getState().setSidebarWidth(20);
    expect(usePortaStore.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("clamps a drag past the maximum", () => {
    usePortaStore.getState().setSidebarWidth(9000);
    expect(usePortaStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("keeps and persists a width inside the range", () => {
    usePortaStore.getState().setSidebarWidth(260);
    expect(usePortaStore.getState().sidebarWidth).toBe(260);
    expect(localStorage.getItem("porta.sidebar.width")).toBe("260");
  });
});
