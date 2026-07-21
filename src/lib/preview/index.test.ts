import { beforeAll, describe, expect, it } from "vitest";
import { renderPreview } from "./index";

// Same reason as mermaid.test.ts: jsdom answers neither SVG measurement API, so
// Mermaid's layout throws before producing markup unless both are stubbed.
beforeAll(() => {
  Object.assign(SVGElement.prototype, {
    getBBox: () => ({ x: 0, y: 0, width: 100, height: 20 }) as DOMRect,
    getComputedTextLength: () => 60,
  });
});

// One document exercising every seam between the four modules. Each of these
// worked in isolation before and still produced a broken preview together:
// markdown left fences escaped and unhighlighted, the language badge pointed at
// a <pre> Shiki replaces, and fence *names* never reached an extension map.
const DOC = [
  "# Title",
  "",
  "Some **text** with a [link](https://example.com).",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[Start] --> B{Decision}",
  "```",
  "",
  "```elixir",
  'defmodule Foo do',
  "  def run(x), do: {:ok, x + 1} # go",
  "end",
  "```",
  "",
  "```cobol",
  "IDENTIFICATION DIVISION.",
  "```",
  "",
  "```sh",
  "echo hi",
  "```",
  "",
].join("\n");

describe("renderPreview", () => {
  let root: HTMLElement;

  beforeAll(async () => {
    root = document.createElement("div");
    document.body.appendChild(root);
    await renderPreview(root, DOC, { dark: true });
  });

  it("keeps the heading and inline markup", () => {
    expect(root.querySelector("h1")?.textContent).toBe("Title");
    expect(root.querySelector("strong")?.textContent).toBe("text");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });

  it("hydrates the mermaid diagram into a real svg", () => {
    const svg = root.querySelector(".md-mermaid svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelector("g")).not.toBeNull();
    expect(root.querySelector(".md-mermaid-error")).toBeNull();
    // The placeholder is consumed, not left behind for a second pass.
    expect(root.querySelector("pre.md-mermaid[data-mermaid]")).toBeNull();
  });

  it("highlights the elixir fence in place of markdown-it's escaped block", () => {
    const pre = root.querySelector<HTMLElement>('pre[data-lang="elixir"]');
    expect(pre, "elixir block").not.toBeNull();
    expect(pre!.classList.contains("shiki"), "replaced by Shiki output").toBe(true);
    // The markdown pass's own markers survive the swap.
    expect(pre!.classList.contains("md-pre")).toBe(true);
    expect(pre!.querySelectorAll("span.line")).toHaveLength(3);
    expect(pre!.querySelector("span[style*='var(--shiki-token-keyword)']")).not.toBeNull();
    expect(pre!.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // No trailing blank line from the fence's own newline.
    expect(pre!.textContent?.endsWith("end")).toBe(true);
  });

  it("renders an unsupported fence as escaped text in the same shape", () => {
    const pre = root.querySelector<HTMLElement>('pre[data-lang="cobol"]');
    expect(pre, "cobol block").not.toBeNull();
    expect(pre!.classList.contains("shiki")).toBe(true);
    expect(pre!.querySelectorAll("span.line")).toHaveLength(1);
    expect(pre!.textContent).toContain("IDENTIFICATION DIVISION.");
  });

  it("highlights a fence written with an alias rather than an extension", () => {
    const pre = root.querySelector<HTMLElement>('pre[data-lang="sh"]');
    expect(pre, "sh block").not.toBeNull();
    // ```sh must highlight exactly as ```shell would; before the normaliser it
    // silently fell through to plain text.
    expect(pre!.querySelector("span[style*='var(--shiki-']")).not.toBeNull();
  });

  it("leaves all four blocks in the output, in source order", () => {
    const blocks = [...root.children].filter((el) => el.tagName === "PRE");
    expect(blocks.map((el) => el.className.includes("md-mermaid") ? "mermaid" : el.getAttribute("data-lang")))
      .toEqual(["mermaid", "elixir", "cobol", "sh"]);
  });

  it("carries no hardcoded colour anywhere a palette should own it", () => {
    for (const pre of root.querySelectorAll<HTMLElement>("pre.md-pre")) {
      expect(pre.outerHTML, pre.dataset.lang).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
