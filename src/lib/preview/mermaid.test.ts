import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMarkdown } from "./markdown";
import { hydrateMermaid } from "./mermaid";

// jsdom implements neither SVG text measurement API. Mermaid's layout code
// calls both while sizing nodes and edges; without a stub every diagram
// throws before it produces any markup. A fixed-size stub still runs the real
// Mermaid layout/render pipeline (d3 selections, dagre layout, SVG assembly)
// end to end — it only replaces the two measurements jsdom cannot answer, it
// does not replace Mermaid's output.
// jsdom falls back to a plain SVGElement for tags it doesn't model in more
// detail (<rect>, <text>, ...) rather than SVGGraphicsElement/
// SVGTextContentElement, so the stub has to live on the common base to reach
// every element Mermaid measures. Object.assign (rather than a direct
// property write) keeps this a type-safe extension of the prototype instead
// of an `as any` cast.
beforeAll(() => {
  Object.assign(SVGElement.prototype, {
    getBBox: () => ({ x: 0, y: 0, width: 100, height: 20 }) as DOMRect,
    getComputedTextLength: () => 60,
  });
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("hydrateMermaid", () => {
  // The extension supported flowchart, stateDiagram-v2, sequenceDiagram and
  // erDiagram. Core must render all four; anything beyond is a bonus.
  it.each([
    ["flowchart", "flowchart TD\n  A[Start] --> B{Decision}"],
    ["state", "stateDiagram-v2\n  [*] --> Idle\n  Idle --> [*]"],
    ["sequence", "sequenceDiagram\n  Alice->>Bob: Hello"],
    ["er", "erDiagram\n  USER ||--o{ ORDER : places"],
  ])("renders an svg for a %s diagram", async (_name, src) => {
    const root = mount(renderMarkdown("```mermaid\n" + src + "\n```"));
    await hydrateMermaid(root, "dark");
    expect(root.querySelector(".md-mermaid svg")).not.toBeNull();
  });

  it("leaves an error message rather than throwing on invalid syntax", async () => {
    const root = mount(renderMarkdown("```mermaid\nnot a real diagram {{{\n```"));
    await expect(hydrateMermaid(root, "dark")).resolves.toBeUndefined();
    expect(root.querySelector(".md-mermaid")?.textContent).toBeTruthy();
  });

  it("does nothing when there are no diagrams", async () => {
    const root = mount(renderMarkdown("# just a heading"));
    await expect(hydrateMermaid(root, "dark")).resolves.toBeUndefined();
  });

  // Parity for the mermaid fixtures lands here rather than in markdown.test.ts:
  // the extension rendered diagrams to SVG inside its markdown pass, so the
  // comparable point in core's pipeline is after hydration.
  //
  // Deliberately NOT the per-tag floor used for markdown. Counting tags is the
  // wrong instrument for SVG: an implementation can satisfy a count with
  // decorative elements instead of a correct diagram, and the extension's own
  // fixtures carry counts inflated by a parser bug (its arrow regex mis-splits
  // "Bob-->>Alice" into a phantom participant). What matters is that a real
  // diagram rendered — so assert the structure Mermaid produces for one.
  it.each(["mermaid-flowchart", "mermaid-others"])(
    "renders a real diagram for every block in %s.md",
    async (name) => {
      const dir = resolve(__dirname, "fixtures/markdown");
      const input = readFileSync(resolve(dir, `${name}.md`), "utf-8");
      const blocks = (input.match(/^```mermaid\s*$/gm) ?? []).length;

      const root = mount(renderMarkdown(input));
      await hydrateMermaid(root, "dark");

      expect(root.querySelectorAll(".md-mermaid svg")).toHaveLength(blocks);
      expect(root.querySelector(".md-mermaid-error")).toBeNull();
      for (const svg of root.querySelectorAll(".md-mermaid svg")) {
        expect(svg.querySelector("g"), "diagram groups").not.toBeNull();
        expect(svg.querySelector("path"), "diagram edges").not.toBeNull();
        expect(svg.textContent?.trim(), "diagram labels").toBeTruthy();
      }
    },
  );
});
