import { describe, expect, it, vi } from "vitest";
import { highlightFileLines, sliceTokenLines } from "./diff-highlight";

/**
 * The whole reason this module exists is context. The extension tokenises each
 * diff line on its own, so a line living inside a multi-line string or a block
 * comment gets coloured as if it were code. These first tests are the design:
 * each one highlights a line *in context* and then highlights that same line
 * *alone* — the way a per-line tokeniser would see it — and asserts the two
 * disagree. If a per-line implementation could pass them, they are not testing
 * anything.
 */
describe("context a per-line tokeniser gets wrong", () => {
  const TEMPLATE_LITERAL = [
    "const sql = `",
    "SELECT * FROM users;",
    "const notCode = true;",
    "`;",
  ].join("\n");

  it("colours a line inside a multi-line string as string content, not as code", async () => {
    const lines = await highlightFileLines(TEMPLATE_LITERAL, "src/db.ts");
    const inContext = lines[2];

    expect(inContext).toContain("--shiki-token-string-expression");
    expect(inContext).not.toContain("--shiki-token-keyword");

    // Same line, no context — a keyword again. This is the bug being fixed.
    const [alone] = await highlightFileLines("const notCode = true;", "src/db.ts");
    expect(alone).toContain("--shiki-token-keyword");
    expect(inContext).not.toBe(alone);
  });

  it("colours a line inside a block comment as comment", async () => {
    const source = ["/*", " if (x) return 1;", "*/", "const y = 2;"].join("\n");
    const lines = await highlightFileLines(source, "src/db.ts");
    const inContext = lines[1];

    expect(inContext).toContain("--shiki-token-comment");
    expect(inContext).not.toContain("--shiki-token-keyword");

    const [alone] = await highlightFileLines(" if (x) return 1;", "src/db.ts");
    expect(alone).toContain("--shiki-token-keyword");
    expect(inContext).not.toBe(alone);
  });

  it("keeps a line that reads as a complete statement inside its real context", async () => {
    // `def f, do: 1` is a whole Elixir definition on its own. Here it is prose
    // inside a @doc heredoc, and must not be coloured as a definition.
    const source = ['@doc """', "def f, do: 1", '"""', "def g, do: 2"].join("\n");
    const lines = await highlightFileLines(source, "lib/porta/app.ex");

    expect(lines[1]).not.toContain("--shiki-token-keyword");
    expect(lines[1]).not.toContain("--shiki-token-function");
    // …while the identical text outside the heredoc still is one.
    expect(lines[3]).toContain("--shiki-token-keyword");

    const [alone] = await highlightFileLines("def f, do: 1", "lib/porta/app.ex");
    expect(alone).toContain("--shiki-token-keyword");
    expect(lines[1]).not.toBe(alone);
  });

  it("reopens context correctly after the multi-line construct closes", async () => {
    const lines = await highlightFileLines(TEMPLATE_LITERAL, "src/db.ts");
    // Line 4 is `\`;` — the backtick still string, the semicolon back to code.
    expect(lines[3]).toContain("--shiki-token-string-expression");
    expect(lines[0]).toContain("--shiki-token-keyword");
  });
});

describe("highlightFileLines", () => {
  it("colours an ordinary keyword as a keyword", async () => {
    const lines = await highlightFileLines("const x = 1;", "src/a.ts");
    expect(lines[0]).toContain("--shiki-token-keyword");
    expect(lines[0]).toContain("const");
  });

  it("resolves the language from the file path", async () => {
    const [ts] = await highlightFileLines("defmodule Foo do", "src/a.ts");
    const [ex] = await highlightFileLines("defmodule Foo do", "lib/a.ex");
    expect(ex).toContain("--shiki-token-keyword");
    expect(ex).not.toBe(ts);
  });

  it("returns one fragment per source line, line 1 at index 0", async () => {
    const source = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
    const lines = await highlightFileLines(source, "src/a.ts");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("a");
    expect(lines[2]).toContain("c");
  });

  it.each([
    ["a trailing newline", "const a = 1;\n"],
    ["a blank line in the middle", "const a = 1;\n\nconst b = 2;"],
    ["only newlines", "\n\n\n"],
    ["an empty file", ""],
    ["a file with no newline at all", "const a = 1;"],
    ["CRLF line endings", "const a = 1;\r\nconst b = 2;\r\n"],
  ])("matches the input's line count exactly with %s", async (_label, source) => {
    const lines = await highlightFileLines(source, "src/a.ts");
    expect(lines).toHaveLength(source.split("\n").length);
  });

  it("emits an empty fragment for a blank line rather than dropping it", async () => {
    const lines = await highlightFileLines("const a = 1;\n\nconst b = 2;", "src/a.ts");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("");
  });

  it("escapes HTML in the source so a fragment cannot inject markup", async () => {
    const lines = await highlightFileLines('const s = "<script>alert(1)</script>";', "src/a.ts");
    expect(lines[0]).not.toContain("<script>");
    expect(lines[0]).toContain("&lt;script&gt;");
  });

  it("emits no hardcoded colour anywhere", async () => {
    const source = ["// note", 'const s = `a', "b`;", "const n = 42;"].join("\n");
    const lines = await highlightFileLines(source, "src/a.ts");
    const html = lines.join("\n");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\brgba?\(/);
    expect(html).not.toMatch(/color:\s*(?!var\()/);
  });

  it("returns escaped plain text for an unsupported language instead of throwing", async () => {
    const lines = await highlightFileLines("<b>hi</b>\nline two", "notes.xyz");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("&lt;b&gt;hi&lt;/b&gt;");
    expect(lines[1]).toBe("line two");
  });

  it("returns escaped plain text when the highlighter fails to load", async () => {
    vi.resetModules();
    vi.doMock("shiki", () => ({
      createCssVariablesTheme: vi.fn(() => ({ name: "porta-syn", tokenColors: [] })),
      createHighlighter: vi.fn(() => Promise.reject(new Error("wasm instantiation failed"))),
    }));

    const { highlightFileLines: fresh } = await import("./diff-highlight");
    const lines = await fresh("const s = '<i>';\nconst t = 2;", "src/a.ts");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("const s = '&lt;i&gt;';");

    vi.doUnmock("shiki");
    vi.resetModules();
  });

  it("returns escaped plain text when tokenising throws", async () => {
    vi.resetModules();
    vi.doMock("shiki", () => ({
      createCssVariablesTheme: vi.fn(() => ({ name: "porta-syn", tokenColors: [] })),
      createHighlighter: vi.fn(() =>
        Promise.resolve({
          getLoadedLanguages: () => ["typescript"],
          loadLanguage: () => Promise.resolve(),
          codeToTokens: () => {
            throw new Error("grammar blew up");
          },
        }),
      ),
    }));

    const { highlightFileLines: fresh } = await import("./diff-highlight");
    const lines = await fresh("const a = 1;\nconst b = 2;", "src/a.ts");
    expect(lines).toEqual(["const a = 1;", "const b = 2;"]);

    vi.doUnmock("shiki");
    vi.resetModules();
  });

  it("returns escaped plain text when the grammar cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("shiki", () => ({
      createCssVariablesTheme: vi.fn(() => ({ name: "porta-syn", tokenColors: [] })),
      createHighlighter: vi.fn(() =>
        Promise.resolve({
          getLoadedLanguages: () => [],
          loadLanguage: () => Promise.reject(new Error("no such grammar")),
          codeToTokens: () => {
            throw new Error("should never be reached");
          },
        }),
      ),
    }));

    const { highlightFileLines: fresh } = await import("./diff-highlight");
    expect(await fresh("const a = 1;", "src/a.ts")).toEqual(["const a = 1;"]);

    vi.doUnmock("shiki");
    vi.resetModules();
  });
});

/**
 * The slicer itself, fed synthetic tokens. Shiki's `codeToTokens` happens to
 * return tokens already grouped per line, but that is its choice, not a
 * guarantee of the token vocabulary: a token carrying a newline is exactly the
 * multi-line-string shape, and it must land on both lines with its styling
 * intact rather than collapsing them into one.
 */
describe("sliceTokenLines", () => {
  const S = "color:var(--shiki-token-string)";

  it("splits a token that spans a newline across both lines, styling intact", () => {
    const lines = sliceTokenLines([[{ content: "a\nb", style: S }]], 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`<span style="${S}">a</span>`);
    expect(lines[1]).toBe(`<span style="${S}">b</span>`);
  });

  it("splits a token spanning several newlines onto every line it covers", () => {
    const lines = sliceTokenLines([[{ content: "one\ntwo\nthree", style: S }]], 3);
    expect(lines).toEqual([
      `<span style="${S}">one</span>`,
      `<span style="${S}">two</span>`,
      `<span style="${S}">three</span>`,
    ]);
  });

  it("keeps a blank line a newline-spanning token passes straight through", () => {
    const lines = sliceTokenLines([[{ content: "a\n\nb", style: S }]], 3);
    expect(lines).toEqual([`<span style="${S}">a</span>`, "", `<span style="${S}">b</span>`]);
  });

  it("joins the tokens of one line in order", () => {
    const K = "color:var(--shiki-token-keyword)";
    const lines = sliceTokenLines([[{ content: "let", style: K }, { content: " x", style: "" }]], 1);
    expect(lines[0]).toBe(`<span style="${K}">let</span><span> x</span>`);
  });

  it("escapes token content and the style attribute", () => {
    const lines = sliceTokenLines([[{ content: "<b>&", style: 'color:"x"' }]], 1);
    expect(lines[0]).toBe('<span style="color:&quot;x&quot;">&lt;b&gt;&amp;</span>');
  });

  it("pads to the requested line count when the tokens run short", () => {
    expect(sliceTokenLines([[{ content: "a", style: S }]], 3)).toEqual([
      `<span style="${S}">a</span>`,
      "",
      "",
    ]);
  });

  it("truncates to the requested line count when the tokens run long", () => {
    expect(sliceTokenLines([[{ content: "a\nb\nc", style: S }]], 2)).toHaveLength(2);
  });
});
