import { beforeAll, describe, expect, it, vi } from "vitest";
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
    await hydrateMermaid(root, { dark: true });
    expect(root.querySelector(".md-mermaid svg")).not.toBeNull();
  });

  it("leaves an error message rather than throwing on invalid syntax", async () => {
    const root = mount(renderMarkdown("```mermaid\nnot a real diagram {{{\n```"));
    await expect(hydrateMermaid(root, { dark: true })).resolves.toBeUndefined();
    expect(root.querySelector(".md-mermaid")?.textContent).toBeTruthy();
  });

  it("does nothing when there are no diagrams", async () => {
    const root = mount(renderMarkdown("# just a heading"));
    await expect(hydrateMermaid(root, { dark: true })).resolves.toBeUndefined();
  });

  // Mermaid's config is global and set once at initialize(). Caching the
  // instance without remembering which theme it was initialised with meant the
  // first preview's palette stuck for the lifetime of the app — flip the tab to
  // `paper` and diagrams stayed dark.
  it("re-themes when the surface flips between dark and light", async () => {
    const src = "```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```";

    const dark = mount(renderMarkdown(src));
    await hydrateMermaid(dark, { dark: true });
    const light = mount(renderMarkdown(src));
    await hydrateMermaid(light, { dark: false });
    const backToDark = mount(renderMarkdown(src));
    await hydrateMermaid(backToDark, { dark: true });

    // Mermaid bakes the active theme's colours into each diagram's <style>.
    // Its per-diagram id prefixes every rule, so normalise those away — what is
    // being compared is the palette, not which render produced it.
    const styles = (root: HTMLElement) =>
      [...root.querySelectorAll("svg style")]
        .map((s) => s.textContent)
        .join("")
        .replace(/md-mermaid-\d+/g, "id");
    expect(styles(light), "light diagram kept the dark theme").not.toBe(styles(dark));
    expect(styles(backToDark)).toBe(styles(dark));

    // A flip must not hand out an id already in the document, or a later
    // mermaid render would target the wrong element.
    const ids = [...document.querySelectorAll(".md-mermaid svg")].map((s) => s.id);
    expect(ids.length).toBeGreaterThan(2);
    expect(new Set(ids).size, "duplicate diagram ids").toBe(ids.length);
  });

  // The chunk is imported lazily and the promise is cached. Caching a *rejected*
  // one meant a single failed load — a chunk that never arrived — disabled every
  // diagram for the lifetime of the app. Mirrors highlight.ts's recovery.
  //
  // hydrateMermaid is documented to never reject: a malformed diagram already
  // degraded to an error class, but a failed chunk load used to escape that
  // path and reject the caller's promise instead. It must degrade the same way.
  it("degrades to an error instead of rejecting when the chunk load fails, and retries next time", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock("mermaid", () => {
      loads++;
      if (loads === 1) return Promise.reject(new Error("chunk load failed"));
      return {
        default: {
          initialize: () => {},
          render: async (id: string) => ({ svg: `<svg id="${id}"><g></g></svg>` }),
        },
      };
    });

    const { hydrateMermaid: fresh } = await import("./mermaid");
    const src = "```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```";

    const first = mount(renderMarkdown(src));
    await expect(fresh(first, { dark: true })).resolves.toBeUndefined();
    expect(first.querySelector(".md-mermaid svg")).toBeNull();
    expect(first.querySelector(".md-mermaid-error")).not.toBeNull();
    expect(first.querySelector(".md-mermaid")?.textContent).toBeTruthy();

    const second = mount(renderMarkdown(src));
    await fresh(second, { dark: true });
    expect(second.querySelector(".md-mermaid svg")).not.toBeNull();
    expect(loads, "the failed load was cached forever").toBe(2);

    vi.doUnmock("mermaid");
    vi.resetModules();
  });

  // The per-write guard only stops *further* writes; it does not undo one
  // already committed. Two blocks, abort landing while the second's render is
  // still in flight: the first must stay hydrated and the second must stay a
  // raw placeholder, proving the loop neither rolls back nor keeps going.
  it("leaves an earlier commit in place and the next block untouched when cancelled mid-loop", async () => {
    vi.resetModules();
    const controller = new AbortController();
    let renderCalls = 0;
    vi.doMock("mermaid", () => ({
      default: {
        initialize: () => {},
        render: async (id: string) => {
          renderCalls++;
          // Fires while the second block's render is still "in flight" from
          // the loop's point of view — before this call returns control to
          // hydrateMermaid's `await`, so the post-await check is what has to
          // catch it, not the top-of-loop one.
          if (renderCalls === 2) controller.abort();
          return { svg: `<svg id="${id}"><g></g></svg>` };
        },
      },
    }));

    const { hydrateMermaid: fresh } = await import("./mermaid");
    const src = [
      "```mermaid",
      "flowchart TD",
      "  A[Start] --> B[End]",
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      "  C[Start] --> D[End]",
      "```",
    ].join("\n");

    const root = mount(renderMarkdown(src));
    await expect(fresh(root, { dark: true }, controller.signal)).resolves.toBeUndefined();

    const blocks = root.querySelectorAll("pre.md-mermaid");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].querySelector("svg"), "first block hydrated").not.toBeNull();
    expect(blocks[0].hasAttribute("data-mermaid"), "first block's placeholder consumed").toBe(false);
    expect(blocks[1].querySelector("svg"), "second block left unhydrated").toBeNull();
    expect(blocks[1].hasAttribute("data-mermaid"), "second block still a raw placeholder").toBe(true);
    expect(renderCalls).toBe(2);

    vi.doUnmock("mermaid");
    vi.resetModules();
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
      await hydrateMermaid(root, { dark: true });

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
