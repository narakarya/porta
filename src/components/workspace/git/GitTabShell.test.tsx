import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePortaStore } from "../../../store";
import { gitFetch, setGitThemeCmd } from "../../../lib/commands";
import GitTab from "../GitTab";

// Only the two commands whose failure path is under test are replaced; the rest
// keep their real out-of-Tauri behaviour (resolve to null/[]), which the shell's
// seeding effects already tolerate.
vi.mock("../../../lib/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/commands")>();
  return { ...actual, gitFetch: vi.fn(async () => {}), setGitThemeCmd: vi.fn(async () => {}) };
});

/**
 * Stand-in for the real Status tab: it holds local state (a draft, exactly like
 * the commit box) and counts its own mounts. Together those make "did the shell
 * unmount it?" observable — a remount both resets the draft and bumps the
 * counter, so a test can't pass by accident on a component that re-fetched.
 */
let statusMounts = 0;
vi.mock("./StatusTab", () => ({
  default: () => {
    const [draft, setDraft] = useState("");
    useEffect(() => { statusMounts += 1; }, []);
    return (
      <div>
        status tab body
        <textarea aria-label="Commit message" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </div>
    );
  },
}));

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
  beforeEach(() => {
    seed();
    statusMounts = 0;
    vi.mocked(gitFetch).mockResolvedValue(undefined);
    vi.mocked(setGitThemeCmd).mockResolvedValue(undefined);
  });

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

  it("surfaces a failed theme write instead of dropping the promise", async () => {
    vi.mocked(setGitThemeCmd).mockRejectedValueOnce(new Error("config write denied"));
    await renderTab();
    await userEvent.click(screen.getByRole("button", { name: /theme/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Forest" }));
    expect(await screen.findByText(/Couldn't save the theme/)).toHaveTextContent("config write denied");
  });

  // The shell's error line is above the body, so it shows on every tab. A sync
  // failure must not follow the user around after they've navigated away.
  it("clears a shell-level error when the active tab changes", async () => {
    vi.mocked(gitFetch).mockRejectedValueOnce(new Error("no route to host"));
    await renderTab();

    const syncAction = screen.getAllByRole("button", { name: /^Sync$/ })[1];
    await userEvent.click(syncAction);
    expect(await screen.findByText(/no route to host/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^History$/ }));
    await act(async () => {});
    expect(screen.queryByText(/no route to host/)).not.toBeInTheDocument();
  });

  // Regression guard for the split: Status holds the commit draft, so the shell
  // must hide it rather than unmount it. `statusMounts` is what makes that
  // distinction observable — a component that remounted and re-fetched would
  // bump the counter even if its content happened to look the same.
  it("keeps the Status tab mounted — and its draft intact — across a tab switch", async () => {
    await renderTab();
    await userEvent.type(screen.getByLabelText("Commit message"), "fix(git): keep the draft");
    expect(statusMounts).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: /^History$/ }));
    await act(async () => {});
    // Hidden, not gone: still in the DOM, still the same mount.
    expect(screen.getByLabelText("Commit message")).not.toBeVisible();
    expect(statusMounts).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: /^Status$/ }));
    await act(async () => {});
    const draft = screen.getByLabelText("Commit message");
    expect(draft).toBeVisible();
    expect(draft).toHaveValue("fix(git): keep the draft");
    expect(statusMounts).toBe(1);
  });
});
