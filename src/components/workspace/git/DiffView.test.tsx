import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App } from "../../../types";
import { gitDiffFile, gitFilePreview } from "../../../lib/commands";
import DiffView from "./DiffView";

// Only the commands DiffView calls are replaced; everything else keeps its
// real out-of-Tauri behaviour.
vi.mock("../../../lib/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/commands")>();
  return {
    ...actual,
    gitDiffFile: vi.fn(),
    gitFilePreview: vi.fn(),
    gitDiscardHunk: vi.fn(async () => {}),
  };
});

const app = { id: "demo", root_dir: "/tmp/demo", kind: "process" } as unknown as App;

// The two words are chosen with no shared substring (unlike e.g. "staged" /
// "unstaged") so a plain textContent check can't accidentally match the wrong
// one — the word-diff highlighter splits changed text across several <span>s,
// so a single-node text matcher isn't reliable here anyway.
const UNSTAGED_DIFF = [
  "diff --git a/foo.txt b/foo.txt",
  "--- a/foo.txt",
  "+++ b/foo.txt",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+banana",
  "",
].join("\n");

const STAGED_DIFF = [
  "diff --git a/foo.txt b/foo.txt",
  "--- a/foo.txt",
  "+++ b/foo.txt",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+mango",
  "",
].join("\n");

/**
 * Stand-in for how StatusTab mounts DiffView: whatever `key` the caller keeps
 * stable across a stage/unstage flip is what decides whether the flip is a
 * prop update or a fresh identity. Counting mounts here — via a mount-only
 * effect on a module-scoped counter, the same technique GitTabShell.test.tsx
 * uses for StatusTab — makes an accidental remount observable even when the
 * eventually-rendered diff looks identical to what a remount would produce.
 */
let diffViewMounts = 0;
function CountingDiffView(props: React.ComponentProps<typeof DiffView>) {
  useEffect(() => {
    diffViewMounts += 1;
  }, []);
  return <DiffView {...props} />;
}

function renderDiff(path: string, staged: boolean, onChanged: () => void) {
  // Keyed on `path` alone — the fixed contract StatusTab.tsx uses: staging a
  // file must not change DiffView's identity.
  return render(
    <CountingDiffView key={path} app={app} path={path} staged={staged} onChanged={onChanged} />,
  );
}

describe("DiffView", () => {
  beforeEach(() => {
    diffViewMounts = 0;
    vi.mocked(gitDiffFile).mockImplementation(async (_root, _path, staged) =>
      staged ? STAGED_DIFF : UNSTAGED_DIFF,
    );
    vi.mocked(gitFilePreview).mockResolvedValue(null);
  });

  it("keeps the split/unified choice across a staged flip, without remounting, and refetches the diff", async () => {
    const onChanged = vi.fn();
    const { container, rerender } = renderDiff("foo.txt", false, onChanged);
    await waitFor(() => expect(container.textContent).toContain("banana"));

    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByRole("button", { name: "Split" })).toHaveClass("bg-accent-bg");

    rerender(<CountingDiffView key="foo.txt" app={app} path="foo.txt" staged={true} onChanged={onChanged} />);

    // The diff actually updates for the new `staged` value — not stale data
    // left over from before the flip.
    await waitFor(() => expect(container.textContent).toContain("mango"));
    expect(container.textContent).not.toContain("banana");

    // The split choice survived the flip...
    expect(screen.getByRole("button", { name: "Split" })).toHaveClass("bg-accent-bg");
    // ...because DiffView was never torn down and rebuilt.
    expect(diffViewMounts).toBe(1);
  });

  it("still resets view state when a different file is selected", async () => {
    const onChanged = vi.fn();
    const { container, rerender } = renderDiff("foo.txt", false, onChanged);
    await waitFor(() => expect(container.textContent).toContain("banana"));
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByRole("button", { name: "Split" })).toHaveClass("bg-accent-bg");

    // A different path is a different identity (StatusTab keys on `path`), so
    // this remounts DiffView from scratch — the split choice does not carry
    // over to an unrelated file.
    rerender(<CountingDiffView key="bar.txt" app={app} path="bar.txt" staged={false} onChanged={onChanged} />);
    await waitFor(() => expect(container.textContent).toContain("banana"));
    expect(screen.getByRole("button", { name: "Unified" })).toHaveClass("bg-accent-bg");
    expect(diffViewMounts).toBe(2);
  });

  it("keeps the Preview↔Diff toggle across a staged flip", async () => {
    const onChanged = vi.fn();
    vi.mocked(gitFilePreview).mockResolvedValue({
      kind: "markdown",
      mime: "text/markdown",
      data: "PREVIEWDATA123",
      truncated: false,
    });
    const { container, rerender } = renderDiff("foo.txt", false, onChanged);
    await waitFor(() => expect(container.textContent).toContain("banana"));

    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(container.textContent).toContain("PREVIEWDATA123"));

    rerender(<CountingDiffView key="foo.txt" app={app} path="foo.txt" staged={true} onChanged={onChanged} />);

    // The underlying diff did refetch for the new `staged` value...
    await waitFor(() => expect(vi.mocked(gitDiffFile)).toHaveBeenCalledWith(app.root_dir, "foo.txt", true));
    // ...but the user was on the Preview surface, and a staged flip alone must
    // not knock them back to Diff.
    await waitFor(() => expect(container.textContent).toContain("PREVIEWDATA123"));
  });
});
