import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { renderMarkdown, countElements } from "./markdown";

const dir = resolve(__dirname, "fixtures/markdown");

// The extension rendered Mermaid diagrams to inline SVG inside its markdown
// pass. Core splits that in two: markdown emits a placeholder, ./mermaid.ts
// hydrates it. So the mermaid fixtures' parity is asserted in mermaid.test.ts
// *after* hydration — comparing them here would measure an unfinished pipeline.
const fixtures = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("mermaid-"));

describe("renderMarkdown", () => {
  it("has fixtures to check against", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  // The parity rule from the spec: core may render more semantic elements than
  // the extension did, never fewer. Both sides are measured with the same
  // countElements, so the comparison cannot drift.
  it.each(fixtures)("renders at least as much as the extension for %s", (name) => {
    const input = readFileSync(resolve(dir, name), "utf-8");
    const expectedHtml = readFileSync(resolve(dir, name.replace(/\.md$/, ".expected.html")), "utf-8");
    const floors = countElements(expectedHtml);
    const actual = countElements(renderMarkdown(input));

    for (const [tag, floor] of Object.entries(floors)) {
      // Mermaid placeholders are hydrated later (Task 4); at this stage they are
      // <pre> elements, which is what the extension emits for them too.
      expect(actual[tag] ?? 0, `<${tag}> count`).toBeGreaterThanOrEqual(floor);
    }
  });

  it("leaves mermaid blocks as hydratable placeholders", () => {
    const html = renderMarkdown("```mermaid\nflowchart TD\n  A --> B\n```");
    expect(html).toContain('class="md-mermaid"');
    expect(html).toContain("data-mermaid=");
    expect(html).not.toContain("<svg");
  });

  it("escapes raw HTML instead of executing it", () => {
    const html = renderMarkdown("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("onerror=alert");
  });
});
