import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePortaStore } from "../../../store";
import {
  gitChangedFiles,
  gitStage,
  gitStageAll,
  gitUnstage,
  gitUnstageAll,
  type ChangedFile,
} from "../../../lib/commands";
import ActivePane from "./ui/ActivePane";
import StatusTab from "./StatusTab";

// The working-tree listing is replaced — it is the call the gate is about — plus
// the four staging commands, so the bulk-action tests can see *which* of them a
// click reached for. The rest keep their real out-of-Tauri behaviour (resolve to
// null/[]).
vi.mock("../../../lib/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/commands")>();
  return {
    ...actual,
    gitChangedFiles: vi.fn(async () => []),
    gitStage: vi.fn(async () => {}),
    gitUnstage: vi.fn(async () => {}),
    gitStageAll: vi.fn(async () => {}),
    gitUnstageAll: vi.fn(async () => {}),
  };
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

function stagedFile(path: string): ChangedFile {
  return { ...file(path), staged_status: "M", unstaged_status: ".", staged: true, unstaged: false };
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

/**
 * The filter over the file list. Every assertion here is about the *input*
 * surviving the list re-deriving underneath it: the reason this tab is being
 * rebuilt at all is that the reference keeps caret and focus across every
 * action and core did not. A filter that rebuilds the pane per keystroke
 * narrows the list correctly and is still unusable.
 */
describe("StatusTab file filter", () => {
  /** Rows carry `title={path}` on their name span — the only stable handle
   *  once the name is split into text + <mark> segments by the highlighter. */
  function row(path: string) {
    return document.querySelector(`[title="${path}"]`);
  }
  function filterBox() {
    return screen.getByPlaceholderText("Filter files…") as HTMLInputElement;
  }
  const tree = () => [
    stagedFile("src/alpha.ts"),
    file("src/beta.ts"),
    file("lib/gizmo.ts"),
  ];

  beforeEach(() => {
    usePortaStore.setState({ appGitError: {} });
    poll(1);
    vi.mocked(gitChangedFiles).mockReset();
    vi.mocked(gitChangedFiles).mockResolvedValue(tree());
    vi.mocked(gitStage).mockClear();
    vi.mocked(gitUnstage).mockClear();
    vi.mocked(gitStageAll).mockClear();
    vi.mocked(gitUnstageAll).mockClear();
  });

  it("narrows both sections and marks the matched substring", async () => {
    await renderTab();
    expect(row("src/alpha.ts")).not.toBeNull();

    await userEvent.type(filterBox(), "z");

    // Unstaged section keeps only the match; staged section says why it's empty.
    expect(row("lib/gizmo.ts")).not.toBeNull();
    expect(row("src/beta.ts")).toBeNull();
    expect(row("src/alpha.ts")).toBeNull();
    expect(screen.getByText("Nothing matches filter")).toBeInTheDocument();

    // The row still reads as its filename, with the matched run marked.
    const name = row("lib/gizmo.ts")!;
    expect(name.textContent).toBe("gizmo.ts");
    const marks = name.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("z");
  });

  /**
   * The assertion this task exists for. Typing *into the middle* of the query
   * is what separates a filter that leaves the input alone from one that
   * rewrites its value — the classic version being an `onChange` that stores
   * `value.toLowerCase()` because matching is case-insensitive. React then
   * writes the normalised string back into the DOM node, and jsdom (like every
   * browser) drops the caret to the end. Appending at the end hides that;
   * typing in the middle does not.
   */
  it("keeps focus and caret when typing into the middle of the query", async () => {
    await renderTab();
    const input = filterBox();

    await userEvent.type(input, "gz");
    await userEvent.type(input, "I", { initialSelectionStart: 1, initialSelectionEnd: 1 });

    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(2);
    expect(input).toHaveValue("gIz");
    // …and the query still matched, case-insensitively.
    expect(row("lib/gizmo.ts")).not.toBeNull();
    expect(row("src/alpha.ts")).toBeNull();
  });

  it("keeps focus, caret, query and draft when a background refresh lands mid-type", async () => {
    await renderTab();
    await userEvent.type(screen.getByPlaceholderText(/Commit message/), "wip");

    const input = filterBox();
    await userEvent.type(input, "giz");
    act(() => input.setSelectionRange(1, 1));

    // A poller tick re-lists the working tree while the user is still typing.
    vi.mocked(gitChangedFiles).mockResolvedValue(tree());
    await act(async () => poll(2));

    expect(gitChangedFiles).toHaveBeenCalledTimes(2);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("giz");
    expect(input.selectionStart).toBe(1);
    expect(row("lib/gizmo.ts")).not.toBeNull();
    expect(row("src/alpha.ts")).toBeNull();
    expect(screen.getByPlaceholderText(/Commit message/)).toHaveValue("wip");
  });

  it("leaves selection, checked rows and the draft alone across filter and clear", async () => {
    await renderTab();
    await userEvent.type(screen.getByPlaceholderText(/Commit message/), "wip");
    await userEvent.click(screen.getByLabelText("Select src/beta.ts"));
    await userEvent.click(row("src/alpha.ts")!);
    await act(async () => {});
    expect(screen.queryByText("Select a file to view its diff")).toBeNull();

    const input = filterBox();
    await userEvent.type(input, "zzz");
    expect(row("src/alpha.ts")).toBeNull();
    expect(row("lib/gizmo.ts")).toBeNull();
    // Checked rows are state, not markup — hiding a row must not uncheck it.
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await userEvent.clear(input);
    expect(row("src/alpha.ts")).not.toBeNull();
    expect(row("src/beta.ts")).not.toBeNull();
    expect(row("lib/gizmo.ts")).not.toBeNull();
    expect(screen.getByLabelText("Select src/beta.ts")).toBeChecked();
    expect(screen.queryByText("Select a file to view its diff")).toBeNull();
    expect(screen.getByPlaceholderText(/Commit message/)).toHaveValue("wip");
  });
});

/**
 * Marking, specifically for queries the per-segment version could not survive.
 * The filter matches on the whole path but no row *displays* a whole path — a
 * directory row shows one segment, a leaf row shows the basename — so a query
 * containing `/` (`src/be`) matches nothing in any single row's text. Matching
 * has to be computed against the path and then projected onto whatever window
 * of it each row draws, or the filter narrows to a row with no mark on it.
 */
describe("StatusTab filter marking across path segments", () => {
  function row(path: string) {
    return document.querySelector(`[title="${path}"]`);
  }
  function marks(path: string) {
    return [...row(path)!.querySelectorAll("mark")].map((m) => m.textContent);
  }
  function filterBox() {
    return screen.getByPlaceholderText("Filter files…") as HTMLInputElement;
  }

  beforeEach(() => {
    usePortaStore.setState({ appGitError: {} });
    poll(1);
    vi.mocked(gitChangedFiles).mockReset();
    vi.mocked(gitChangedFiles).mockResolvedValue([
      stagedFile("src/alpha.ts"),
      file("src/beta.ts"),
      file("lib/gizmo.ts"),
    ]);
  });

  it("marks the directory row and the leaf row for a query containing a slash", async () => {
    await renderTab();
    await userEvent.type(filterBox(), "src/be");

    expect(row("src/alpha.ts")).toBeNull();
    expect(row("lib/gizmo.ts")).toBeNull();

    // Leaf shows only the basename; the query's tail lands inside it.
    expect(row("src/beta.ts")!.textContent).toBe("beta.ts");
    expect(marks("src/beta.ts")).toEqual(["be"]);
    // The directory row it hangs under carries the query's head.
    expect(row("src")!.textContent).toBe("src");
    expect(marks("src")).toEqual(["src"]);
  });

  it("splits a boundary-spanning query across the two rows that show it", async () => {
    await renderTab();
    await userEvent.type(filterBox(), "b/g");

    expect(row("src/beta.ts")).toBeNull();
    expect(marks("lib")).toEqual(["b"]);
    expect(row("lib")!.textContent).toBe("lib");
    expect(marks("lib/gizmo.ts")).toEqual(["g"]);
    expect(row("lib/gizmo.ts")!.textContent).toBe("gizmo.ts");
  });

  it("marks only the directory row when the query matches only a directory", async () => {
    await renderTab();
    await userEvent.type(filterBox(), "lib/");

    expect(marks("lib")).toEqual(["lib"]);
    expect(marks("lib/gizmo.ts")).toEqual([]);
  });

  it("marks only the leaf row when the query matches only the basename", async () => {
    await renderTab();
    await userEvent.type(filterBox(), "giz");

    expect(marks("lib")).toEqual([]);
    expect(marks("lib/gizmo.ts")).toEqual(["giz"]);
  });
});

/**
 * Two decisions that only bite while a filter is on: what "all" means, and
 * which count the header is reporting.
 */
describe("StatusTab bulk actions and counts under a filter", () => {
  function filterBox() {
    return screen.getByPlaceholderText("Filter files…") as HTMLInputElement;
  }

  beforeEach(() => {
    usePortaStore.setState({ appGitError: {} });
    poll(1);
    vi.mocked(gitChangedFiles).mockReset();
    vi.mocked(gitChangedFiles).mockResolvedValue([
      stagedFile("src/alpha.ts"),
      file("src/beta.ts"),
      file("lib/gizmo.ts"),
    ]);
    vi.mocked(gitStage).mockClear();
    vi.mocked(gitUnstage).mockClear();
    vi.mocked(gitStageAll).mockClear();
    vi.mocked(gitUnstageAll).mockClear();
  });

  it("stages every change in the section when nothing is filtered out", async () => {
    await renderTab();
    await userEvent.click(screen.getByRole("button", { name: "Stage all" }));
    await act(async () => {});

    expect(gitStageAll).toHaveBeenCalledTimes(1);
    expect(gitStage).not.toHaveBeenCalled();
  });

  it("stages exactly the visible rows while a filter is on, and says so", async () => {
    await renderTab();
    await userEvent.type(filterBox(), "giz");

    // The label has to stop claiming "all" once "all" is not what it does.
    expect(screen.queryByRole("button", { name: "Stage all" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Stage shown" }));
    await act(async () => {});

    expect(gitStageAll).not.toHaveBeenCalled();
    expect(vi.mocked(gitStage).mock.calls.map((c) => c[1])).toEqual(["lib/gizmo.ts"]);
    // src/beta.ts was hidden by the filter — it must be untouched.
    expect(vi.mocked(gitStage).mock.calls.map((c) => c[1])).not.toContain("src/beta.ts");
  });

  it("unstages exactly the visible rows while a filter is on", async () => {
    await renderTab();
    await userEvent.type(filterBox(), "alpha");

    expect(screen.queryByRole("button", { name: "Unstage all" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Unstage shown" }));
    await act(async () => {});

    expect(gitUnstageAll).not.toHaveBeenCalled();
    expect(vi.mocked(gitUnstage).mock.calls.map((c) => c[1])).toEqual(["src/alpha.ts"]);
  });

  it("reports shown-against-total in the header only while a filter is on", async () => {
    await renderTab();
    expect(screen.getByText("Changes · 2")).toBeInTheDocument();
    expect(screen.getByText("Staged Changes · 1")).toBeInTheDocument();

    await userEvent.type(filterBox(), "giz");
    expect(screen.getByText("Changes · 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Staged Changes · 0 of 1")).toBeInTheDocument();
  });
});
