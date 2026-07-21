import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderMarkdown, countElements } from "./markdown";
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
  it.each(["mermaid-flowchart", "mermaid-others"])(
    "renders at least as much as the extension for %s.md",
    async (name) => {
      const dir = resolve(__dirname, "fixtures/markdown");
      const input = readFileSync(resolve(dir, `${name}.md`), "utf-8");
      const floors = countElements(readFileSync(resolve(dir, `${name}.expected.html`), "utf-8"));

      const root = mount(renderMarkdown(input));
      await hydrateMermaid(root, "dark");
      const actual = countElements(root.innerHTML);

      for (const [tag, floor] of Object.entries(floors)) {
        expect(actual[tag] ?? 0, `<${tag}> count`).toBeGreaterThanOrEqual(floor);
      }
    },
  );
});
