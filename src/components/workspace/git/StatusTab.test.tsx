import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePortaStore } from "../../../store";
import { gitChangedFiles, type ChangedFile } from "../../../lib/commands";
import ActivePane from "./ui/ActivePane";
import StatusTab from "./StatusTab";

// Only the working-tree listing is replaced — it is the call the gate is about.
// The rest keep their real out-of-Tauri behaviour (resolve to null/[]).
vi.mock("../../../lib/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/commands")>();
  return { ...actual, gitChangedFiles: vi.fn(async () => []) };
});

const app = { id: "demo", root_dir: "/tmp/demo", kind: "process" } as never;

function file(path: string): ChangedFile {
  return {
    path,
    orig_path: null,
    staged_status: ".",
    unstaged_status: "M",
    staged: false,
    unstaged: true,
    untracked: false,
    insertions: 1,
    deletions: 0,
  };
}

/** A fresh GitStatus object — identity is what the refetch effect keys on. */
function poll(dirty: number) {
  usePortaStore.setState({
    appGit: { demo: { branch: "main", detached: false, upstream: "origin/main", ahead: 0, behind: 0, dirty } },
  });
}

/**
 * Puts the tab in the same slot the shell uses, with a switch for the one thing
 * under test. The button is outside the pane so it stays clickable while the
 * pane is hidden.
 */
function Harness() {
  const [active, setActive] = useState(true);
  return (
    <>
      <button onClick={() => setActive((v) => !v)}>toggle pane</button>
      <ActivePane active={active} className="flex flex-col">
        <StatusTab app={app} onError={() => {}} />
      </ActivePane>
    </>
  );
}

async function renderTab() {
  const view = render(<Harness />);
  await act(async () => {});
  return view;
}

describe("StatusTab active-pane gate", () => {
  beforeEach(() => {
    usePortaStore.setState({ appGitError: {} });
    poll(1);
    vi.mocked(gitChangedFiles).mockReset();
    vi.mocked(gitChangedFiles).mockResolvedValue([file("src/one.ts")]);
  });

  it("lists the working tree once the pane is on screen", async () => {
    await renderTab();
    expect(gitChangedFiles).toHaveBeenCalledTimes(1);
    expect(screen.getByText("one.ts")).toBeInTheDocument();
  });

  /**
   * The distinction this test turns on: a *hidden* tab and an *unmounted* tab
   * both stop fetching, and only one of them keeps the user's commit draft. So
   * the poll below must leave `gitChangedFiles` uncalled (idled) **and** leave
   * the textarea in the DOM holding what was typed (not unmounted). Either
   * assertion alone would pass on the wrong implementation.
   */
  it("idles the refetch while hidden without dropping the draft", async () => {
    await renderTab();
    await userEvent.type(screen.getByPlaceholderText(/Commit message/), "fix(git): keep me");
    expect(gitChangedFiles).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "toggle pane" }));

    // A poller tick lands while the user is on another tab.
    await act(async () => poll(2));
    expect(gitChangedFiles).toHaveBeenCalledTimes(1);

    // Hidden, not gone — and the draft is untouched.
    const draft = screen.getByPlaceholderText(/Commit message/);
    expect(draft).not.toBeVisible();
    expect(draft).toHaveValue("fix(git): keep me");
  });

  /**
   * The other half of the gate: a pane that idled must not come back showing
   * what it had before it was hidden. The second listing returns a different
   * file, so a stale pane is visibly a failure rather than a coincidence.
   */
  it("re-lists on reactivation instead of showing what it had", async () => {
    await renderTab();
    await userEvent.type(screen.getByPlaceholderText(/Commit message/), "fix(git): keep me");

    await userEvent.click(screen.getByRole("button", { name: "toggle pane" }));
    vi.mocked(gitChangedFiles).mockResolvedValue([file("src/two.ts")]);
    await act(async () => poll(2));
    expect(gitChangedFiles).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "toggle pane" }));
    await act(async () => {});
    expect(gitChangedFiles).toHaveBeenCalledTimes(2);
    expect(screen.getByText("two.ts")).toBeInTheDocument();
    expect(screen.queryByText("one.ts")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Commit message/)).toHaveValue("fix(git): keep me");
  });
});
