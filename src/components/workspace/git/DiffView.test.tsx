import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App } from "../../../types";
import { gitDiffFile, gitFilePreview } from "../../../lib/commands";
import DiffView from "./DiffView";

// Same reason as src/lib/preview/index.test.ts: jsdom answers neither SVG
// measurement API, so Mermaid's layout throws before producing markup unless
// both are stubbed. The preview tests below drive the *real* renderPreview —
// mocking it would prove nothing about the composition this task exists to
// wire up — so the same stubs are needed here.
beforeAll(() => {
  Object.assign(SVGElement.prototype, {
    getBBox: () => ({ x: 0, y: 0, width: 100, height: 20 }) as DOMRect,
    getComputedTextLength: () => 60,
  });
});

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

  // Regression test for the scroll-position contract: DiffView is meant to
  // keep its scroll offset across a staged flip too, but the container that
  // actually scrolls lives one level up in StatusTab and never unmounts.
  // jsdom doesn't lay out, so it never clamps a stale `scrollTop` against a
  // shrunk `scrollHeight` the way a real browser does — a probe confirmed
  // that stubbing `scrollHeight`/`clientHeight` on the element prototype
  // (the pattern `useContextMenu`'s viewport-clamp test uses for
  // `getBoundingClientRect`) has no effect on `scrollTop` here: jsdom just
  // stores whatever value is assigned, unconditionally, so a
  // set-scrollTop-then-assert-it-survived test would pass identically on the
  // unfixed code — a false negative, not real coverage. So this asserts the
  // actual mechanism instead: a full "Loading diff…" replacement is exactly
  // what collapses the container's content (which is what makes a real
  // browser clamp `scrollTop`), so the fix's contract is that the
  // previously-rendered diff must stay mounted, unreplaced, for the entire
  // span a same-instance refetch is in flight.
  it("keeps the previous diff mounted — never a blank 'Loading diff…' swap — while a staged flip refetches", async () => {
    const onChanged = vi.fn();
    let resolveSecondFetch: ((diff: string) => void) | undefined;
    let calls = 0;
    vi.mocked(gitDiffFile).mockImplementation((_root, _path, staged) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(staged ? STAGED_DIFF : UNSTAGED_DIFF);
      return new Promise<string>((resolve) => { resolveSecondFetch = resolve; });
    });

    const { container, rerender } = renderDiff("foo.txt", false, onChanged);
    await waitFor(() => expect(container.textContent).toContain("banana"));

    rerender(<CountingDiffView key="foo.txt" app={app} path="foo.txt" staged={true} onChanged={onChanged} />);

    // The staged-flip refetch is now in flight (its promise deliberately left
    // unresolved above) — this is the exact window where the old code
    // replaced the whole tree with the one-line loading state.
    await waitFor(() => expect(calls).toBe(2));
    expect(container.textContent).toContain("banana");
    expect(container.textContent).not.toContain("Loading diff…");

    resolveSecondFetch?.(STAGED_DIFF);
    await waitFor(() => expect(container.textContent).toContain("mango"));
    expect(container.textContent).not.toContain("banana");
  });
});

// ── The preview surface ────────────────────────────────────────────────────
//
// Deliberately against the real `renderPreview` (markdown-it + Mermaid +
// Shiki), not a mock: every one of those modules already passes its own unit
// tests in isolation, and had never once run together behind this component.
// A mocked renderer would assert that DiffView calls a function — which is not
// the thing that was broken.
//
// Shiki loads a grammar and Mermaid loads its chunk on first use, both real
// work in jsdom, so these get a wider timeout than the default 5s.
const PREVIEW_TIMEOUT = 30_000;

const MARKDOWN_DOC = [
  "# Release notes",
  "",
  "Shipped **today**.",
  "",
  "- first item",
  "- second item",
  "",
].join("\n");

// The highlighting case reached through markdown: a fenced block inside a
// markdown preview. The whole-file `code` kind is the other route to Shiki and
// is covered separately at the bottom of this file.
const ELIXIR_DOC = [
  "```elixir",
  "defmodule Foo do",
  "  def run(x), do: {:ok, x + 1}",
  "end",
  "```",
  "",
].join("\n");

const MERMAID_DOC = [
  "# Diagram",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[Start] --> B{Decision}",
  "```",
  "",
].join("\n");

function markdownPreview(data: string) {
  return { kind: "markdown" as const, mime: "text/markdown", data, truncated: false };
}

/** Mounts DiffView for a markdown file and switches to the Preview surface —
 *  a markdown preview opens on Diff, so the toggle is the way in. */
async function openPreview(doc: string) {
  vi.mocked(gitFilePreview).mockResolvedValue(markdownPreview(doc));
  const view = renderDiff("notes.md", false, vi.fn());
  await waitFor(() => expect(view.container.textContent).toContain("banana"));
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  return view;
}

describe("DiffView preview surface", () => {
  beforeEach(() => {
    diffViewMounts = 0;
    vi.mocked(gitDiffFile).mockResolvedValue(UNSTAGED_DIFF);
    vi.mocked(gitFilePreview).mockResolvedValue(null);
  });

  it("renders a markdown preview as markdown, not as text", async () => {
    const { container } = await openPreview(MARKDOWN_DOC);

    await waitFor(
      () => expect(container.querySelector("h1")?.textContent).toBe("Release notes"),
      { timeout: PREVIEW_TIMEOUT },
    );
    expect(container.querySelector("strong")?.textContent).toBe("today");
    expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "first item",
      "second item",
    ]);
    // The old hand-rolled renderer emitted a literal bullet character in a
    // <div>; a real <ul> is what says the pipeline is in play.
    expect(container.querySelector("ul")).not.toBeNull();
  }, PREVIEW_TIMEOUT);

  // The single cheapest guard against the silent-failure mode: every rule in
  // src/styles/git-preview.css is scoped `.git-tab-root .md-body …`, so a
  // container without this class renders a completely unstyled preview while
  // every other assertion here still passes.
  it("hands renderPreview a container carrying md-body, the class the stylesheet hooks", async () => {
    const { container } = await openPreview(MARKDOWN_DOC);

    await waitFor(
      () => expect(container.querySelector(".md-body h1")?.textContent).toBe("Release notes"),
      { timeout: PREVIEW_TIMEOUT },
    );
  }, PREVIEW_TIMEOUT);

  it("highlights a code fence through the palette's variables, with no baked-in colours", async () => {
    const { container } = await openPreview(ELIXIR_DOC);

    await waitFor(
      () => expect(container.querySelector('pre[data-lang="elixir"].shiki')).not.toBeNull(),
      { timeout: PREVIEW_TIMEOUT },
    );
    const pre = container.querySelector<HTMLElement>('pre[data-lang="elixir"]')!;
    // Token colours must resolve through --shiki-token-*, which git-theme.css
    // binds to the palette. A Shiki theme's baked hex would pin every preview
    // to that theme regardless of which of the seven palettes is active.
    expect(pre.querySelector("span[style*='var(--shiki-token-']")).not.toBeNull();
    expect(pre.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(pre.textContent).toContain("defmodule Foo do");
  }, PREVIEW_TIMEOUT);

  it("hydrates a mermaid fence into a real diagram", async () => {
    const { container } = await openPreview(MERMAID_DOC);

    await waitFor(
      () => expect(container.querySelector(".md-mermaid svg")).not.toBeNull(),
      { timeout: PREVIEW_TIMEOUT },
    );
    expect(container.querySelector(".md-mermaid-error")).toBeNull();
    // The placeholder is consumed rather than left for a second pass.
    expect(container.querySelector("pre.md-mermaid[data-mermaid]")).toBeNull();
  }, PREVIEW_TIMEOUT);

  // The cancellation contract from Task 2, seen from the consumer's side. The
  // key is held stable here on purpose: that keeps one DiffView instance and
  // one preview host element across the switch, which is the case where an
  // earlier render could still write into the *live* node. A key change would
  // hand the later file a brand-new node and prove nothing.
  it("leaves the later file's preview on screen when the file switches mid-render", async () => {
    vi.mocked(gitFilePreview).mockImplementation(async (_root, path) =>
      markdownPreview(path === "alpha.md" ? MERMAID_DOC.replace("# Diagram", "# Alpha") : "# Bravo\n"),
    );
    const onChanged = vi.fn();
    const { container, rerender } = render(
      <CountingDiffView key="stable" app={app} path="alpha.md" staged={false} onChanged={onChanged} />,
    );
    await waitFor(() => expect(container.textContent).toContain("banana"));
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    // Alpha's markdown is on screen; its Mermaid hydration is still in flight
    // (the chunk load and render are genuinely async), which is the window the
    // switch below lands in.
    await waitFor(() => expect(container.textContent).toContain("Alpha"), {
      timeout: PREVIEW_TIMEOUT,
    });

    rerender(
      <CountingDiffView key="stable" app={app} path="bravo.md" staged={false} onChanged={onChanged} />,
    );

    // Asserted through the pipeline's own output, not raw text: a plain-text
    // fallback would satisfy `textContent` alone while proving nothing about
    // which render won the live node.
    await waitFor(
      () => expect(container.querySelector(".md-body h1")?.textContent).toBe("Bravo"),
      { timeout: PREVIEW_TIMEOUT },
    );
    expect(container.textContent).not.toContain("Alpha");
    // Nothing from the abandoned render is left behind in the live node.
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".md-mermaid")).toBeNull();
    expect(diffViewMounts).toBe(1);
  }, PREVIEW_TIMEOUT);
});

// ── The `code` kind: a whole source file as its own preview ────────────────
//
// `git_file_preview` used to return None for anything that wasn't
// md/html/csv/tsv/image, so a `.ex` file had a diff and nothing else. It now
// falls through to `code`, and that content has to reach the same
// markdown→mermaid→Shiki pipeline the markdown kind uses — same real modules
// here, same reason: a mock would assert a call, not a rendered token.

const ELIXIR_SOURCE = [
  "defmodule Foo do",
  "  def run(x), do: {:ok, x + 1}",
  "end",
  "",
].join("\n");

function codePreview(data: string) {
  return { kind: "code" as const, mime: "text/plain", data, truncated: false };
}

async function openCodePreview(path: string, data: string) {
  vi.mocked(gitFilePreview).mockResolvedValue(codePreview(data));
  const view = renderDiff(path, false, vi.fn());
  await waitFor(() => expect(view.container.textContent).toContain("banana"));
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  return view;
}

describe("DiffView code preview", () => {
  beforeEach(() => {
    diffViewMounts = 0;
    vi.mocked(gitDiffFile).mockResolvedValue(UNSTAGED_DIFF);
    vi.mocked(gitFilePreview).mockResolvedValue(null);
  });

  it("previews an .ex file as highlighted code, coloured only through the palette's variables", async () => {
    const { container } = await openCodePreview("lib/foo.ex", ELIXIR_SOURCE);

    // The language comes from the *path* (langFromPath), not from anything in
    // the payload — the backend sends plain text and no language at all.
    await waitFor(
      () => expect(container.querySelector('.md-body pre[data-lang="elixir"].shiki')).not.toBeNull(),
      { timeout: PREVIEW_TIMEOUT },
    );
    const pre = container.querySelector<HTMLElement>('pre[data-lang="elixir"]')!;
    expect(pre.querySelector("span[style*='var(--shiki-token-']")).not.toBeNull();
    expect(pre.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(pre.textContent).toContain("defmodule Foo do");
    expect(pre.textContent).toContain("{:ok, x + 1}");
    // The file's own three lines and no more: the fence wrapper has to supply
    // a newline before its closing delimiter, and a file that already ends
    // with one must not gain a phantom blank line at the bottom.
    expect(pre.querySelectorAll("span.line")).toHaveLength(3);
  }, PREVIEW_TIMEOUT);

  // The file is handed to the pipeline as a fenced block, so its own content
  // must not be able to close that fence — a markdown file full of ``` runs
  // would otherwise render as half code and half interpreted markdown.
  it("keeps a file containing its own code fences inside one block", async () => {
    const doc = ["# heading", "", "```", "not a fence terminator", "```", ""].join("\n");
    const { container } = await openCodePreview("notes.txt", doc);

    await waitFor(() => expect(container.querySelector(".md-body pre")).not.toBeNull(), {
      timeout: PREVIEW_TIMEOUT,
    });
    // Nothing was interpreted: no heading element, exactly one block, and the
    // backticks survive as literal text.
    expect(container.querySelector(".md-body h1")).toBeNull();
    expect(container.querySelectorAll(".md-body pre")).toHaveLength(1);
    expect(container.querySelector(".md-body pre")!.textContent).toContain("# heading");
    expect(container.querySelector(".md-body pre")!.textContent).toContain("```");
  }, PREVIEW_TIMEOUT);

  it("renders an unmapped extension as unhighlighted text rather than dropping the preview", async () => {
    const { container } = await openCodePreview("data/notes.txt", "plain line one\nplain line two\n");

    await waitFor(
      () => expect(container.querySelector(".md-body pre.shiki")).not.toBeNull(),
      { timeout: PREVIEW_TIMEOUT },
    );
    expect(container.querySelector(".md-body pre")!.textContent).toContain("plain line one");
  }, PREVIEW_TIMEOUT);
});
