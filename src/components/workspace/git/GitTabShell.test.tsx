import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePortaStore } from "../../../store";
import GitTab from "../GitTab";

vi.mock("./StatusTab", () => ({ default: () => <div>status tab body</div> }));

const app = { id: "demo", root_dir: "/tmp/demo", kind: "process" } as never;

/**
 * The shell renders its chrome only once the store has a GitStatus for the app
 * (otherwise it short-circuits to "Not a git repository"). Outside Tauri the
 * command wrappers resolve to null, so the status has to be seeded here.
 */
function seed() {
  usePortaStore.setState({
    appGit: { demo: { branch: "main", detached: false, upstream: "origin/main", ahead: 0, behind: 0, dirty: 0 } },
    appGitError: {},
    gitAdvancedEnabled: true,
    gitTheme: "dark",
  });
}

/** Mount and flush the effects' already-resolved command promises. */
async function renderTab() {
  const view = render(<GitTab app={app} />);
  await act(async () => {});
  return view;
}

describe("GitTab shell", () => {
  beforeEach(seed);

  it("renders the Status tab body through the extracted component", async () => {
    await renderTab();
    expect(screen.getByText("status tab body")).toBeInTheDocument();
  });

  it("keeps the shell chrome — sub-nav, branch pill and sync — around that body", async () => {
    await renderTab();
    expect(screen.getByRole("button", { name: /^Status$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Rebase$/ })).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    // The Sync sub-nav tab and the header's Sync action are both present.
    expect(screen.getAllByRole("button", { name: /^Sync$/ })).toHaveLength(2);
  });

  it("hides advanced tabs when the advanced-tools tier is off", async () => {
    usePortaStore.setState({ gitAdvancedEnabled: false });
    await renderTab();
    expect(screen.getByRole("button", { name: /^Status$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Rebase$/ })).not.toBeInTheDocument();
  });

  it("puts the palette on the tab root and nowhere else", async () => {
    const { container } = await renderTab();
    const root = container.querySelector(".git-tab-root");
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute("data-git-theme");
    expect(document.documentElement).not.toHaveAttribute("data-git-theme");
    expect(document.body).not.toHaveAttribute("data-git-theme");
  });

  it("reflects the store's palette on the tab root", async () => {
    usePortaStore.setState({ gitTheme: "paper" });
    const { container } = await renderTab();
    expect(container.querySelector(".git-tab-root")).toHaveAttribute("data-git-theme", "paper");
  });

  it("offers every palette in the theme picker", async () => {
    await renderTab();
    await userEvent.click(screen.getByRole("button", { name: /theme/i }));
    for (const label of ["Dark", "Graphite", "Soft Dark", "Midnight", "Paper", "Forest", "Sunset"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
  });

  it("persists the picked palette through the store", async () => {
    await renderTab();
    await userEvent.click(screen.getByRole("button", { name: /theme/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Forest" }));
    expect(usePortaStore.getState().gitTheme).toBe("forest");
  });
});
