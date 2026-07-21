import { describe, expect, it, vi } from "vitest";
import {
  canHighlightPath,
  highlightFileTokens,
  sliceTokenLinesToTokens,
  type StyledToken,
} from "./diff-highlight";

/** The styles carried by one line's tokens, joined — a colour assertion is
 *  about which `--shiki-token-*` variables a line ended up wearing, not about
 *  how many tokens it was cut into. */
function stylesOf(lines: StyledToken[][] | null, index: number): string {
  expect(lines).not.toBeNull();
  return lines![index].map((token) => token.style).join(" ");
}

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
    const inContext = stylesOf(await highlightFileTokens(TEMPLATE_LITERAL, "src/db.ts"), 2);

    expect(inContext).toContain("--shiki-token-string-expression");
    expect(inContext).not.toContain("--shiki-token-keyword");

    // Same line, no context — a keyword again. This is the bug being fixed.
    const alone = stylesOf(await highlightFileTokens("const notCode = true;", "src/db.ts"), 0);
    expect(alone).toContain("--shiki-token-keyword");
    expect(inContext).not.toBe(alone);
  });

  it("colours a line inside a block comment as comment", async () => {
    const source = ["/*", " if (x) return 1;", "*/", "const y = 2;"].join("\n");
    const inContext = stylesOf(await highlightFileTokens(source, "src/db.ts"), 1);

    expect(inContext).toContain("--shiki-token-comment");
    expect(inContext).not.toContain("--shiki-token-keyword");

    const alone = stylesOf(await highlightFileTokens(" if (x) return 1;", "src/db.ts"), 0);
    expect(alone).toContain("--shiki-token-keyword");
    expect(inContext).not.toBe(alone);
  });

  it("keeps a line that reads as a complete statement inside its real context", async () => {
    // `def f, do: 1` is a whole Elixir definition on its own. Here it is prose
    // inside a @doc heredoc, and must not be coloured as a definition.
    const source = ['@doc """', "def f, do: 1", '"""', "def g, do: 2"].join("\n");
    const lines = await highlightFileTokens(source, "lib/porta/app.ex");

    expect(stylesOf(lines, 1)).not.toContain("--shiki-token-keyword");
    expect(stylesOf(lines, 1)).not.toContain("--shiki-token-function");
    // …while the identical text outside the heredoc still is one.
    expect(stylesOf(lines, 3)).toContain("--shiki-token-keyword");

    const alone = stylesOf(await highlightFileTokens("def f, do: 1", "lib/porta/app.ex"), 0);
    expect(alone).toContain("--shiki-token-keyword");
    expect(stylesOf(lines, 1)).not.toBe(alone);
  });

  it("reopens context correctly after the multi-line construct closes", async () => {
    const lines = await highlightFileTokens(TEMPLATE_LITERAL, "src/db.ts");
    // Line 4 is `\`;` — the backtick still string, the semicolon back to code.
    expect(stylesOf(lines, 3)).toContain("--shiki-token-string-expression");
    expect(stylesOf(lines, 0)).toContain("--shiki-token-keyword");
  });
});

/**
 * The slicer itself, fed synthetic tokens. Shiki's `codeToTokens` happens to
 * return tokens already grouped per line, but that is its choice, not a
 * guarantee of the token vocabulary: a token carrying a newline is exactly the
 * multi-line-string shape, and it must land on both lines with its styling
 * intact rather than collapsing them into one.
 */
describe("sliceTokenLinesToTokens", () => {
  const S = "color:var(--shiki-token-string)";

  it("splits a token that spans a newline across both lines, styling intact", () => {
    expect(sliceTokenLinesToTokens([[{ content: "a\nb", style: S }]], 2)).toEqual([
      [{ content: "a", style: S }],
      [{ content: "b", style: S }],
    ]);
  });

  it("splits a token spanning several newlines onto every line it covers", () => {
    expect(sliceTokenLinesToTokens([[{ content: "one\ntwo\nthree", style: S }]], 3)).toEqual([
      [{ content: "one", style: S }],
      [{ content: "two", style: S }],
      [{ content: "three", style: S }],
    ]);
  });

  it("gives a blank line an empty token list rather than an empty token", () => {
    expect(sliceTokenLinesToTokens([[{ content: "a\n\nb", style: S }]], 3)).toEqual([
      [{ content: "a", style: S }],
      [],
      [{ content: "b", style: S }],
    ]);
  });

  it("keeps the tokens of one line in order", () => {
    const K = "color:var(--shiki-token-keyword)";
    expect(
      sliceTokenLinesToTokens([[{ content: "let", style: K }, { content: " x", style: "" }]], 1),
    ).toEqual([[{ content: "let", style: K }, { content: " x", style: "" }]]);
  });

  it("pads and truncates to the requested line count", () => {
    expect(sliceTokenLinesToTokens([[{ content: "a", style: S }]], 3)).toHaveLength(3);
    expect(sliceTokenLinesToTokens([[{ content: "a\nb\nc", style: S }]], 2)).toHaveLength(2);
  });

  it("reconstructs each line's text exactly, which is what lets a caller trust it", () => {
    // The diff surface compares the concatenated token content against the
    // line the diff says is there and refuses to paint on a mismatch, so this
    // property is load-bearing, not incidental.
    const source = "const a = 1;\n  return a;\n";
    const tokens = sliceTokenLinesToTokens(
      [
        [{ content: "const", style: S }, { content: " a = 1;", style: "" }],
        [{ content: "  return a;", style: "" }],
        [],
      ],
      3,
    );
    expect(tokens.map((line) => line.map((t) => t.content).join(""))).toEqual(
      source.split("\n"),
    );
  });
});

describe("highlightFileTokens", () => {
  it("colours a line by its real context, not by how the line reads alone", () => {
    // The design, restated at the level the diff surface consumes.
    const source = ["const sql = `", "const notCode = true;", "`;"].join("\n");
    return highlightFileTokens(source, "src/db.ts").then((lines) => {
      expect(lines).not.toBeNull();
      const styles = lines![1].map((t) => t.style).join(" ");
      expect(styles).toContain("--shiki-token-string-expression");
      expect(styles).not.toContain("--shiki-token-keyword");
    });
  });

  it("resolves the language from the file path", async () => {
    const ts = stylesOf(await highlightFileTokens("defmodule Foo do", "src/a.ts"), 0);
    const ex = stylesOf(await highlightFileTokens("defmodule Foo do", "lib/a.ex"), 0);
    expect(ex).toContain("--shiki-token-keyword");
    expect(ex).not.toBe(ts);
  });

  it.each([
    ["a trailing newline", "const a = 1;\n"],
    ["a blank line in the middle", "const a = 1;\n\nconst b = 2;"],
    ["only newlines", "\n\n\n"],
    ["an empty file", ""],
    ["a file with no newline at all", "const a = 1;"],
    ["CRLF line endings", "const a = 1;\r\nconst b = 2;\r\n"],
  ])("matches the input's line count exactly with %s", async (_label, source) => {
    const lines = await highlightFileTokens(source, "src/a.ts");
    expect(lines).toHaveLength(source.split("\n").length);
  });

  it("has exactly one entry per line, including the phantom one a trailing newline makes", async () => {
    const lines = await highlightFileTokens("const a = 1;\n", "src/a.ts");
    expect(lines).toHaveLength(2);
    expect(lines![1]).toEqual([]);
  });

  it("emits no hardcoded colour anywhere — every one is a palette variable", async () => {
    const source = ["// note", 'const s = `a', "b`;", "const n = 42;"].join("\n");
    const lines = await highlightFileTokens(source, "src/a.ts");
    const styles = lines!.flat().map((token) => token.style).join(";");
    expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(styles).not.toMatch(/\brgba?\(/);
    expect(styles).not.toMatch(/color:\s*(?!var\()/);
  });

  it("answers null — not an empty highlight — when there is no grammar for the path", async () => {
    // Distinct answers on purpose: null lets the caller leave its existing
    // plain rendering alone instead of wrapping every line in styleless spans.
    expect(await highlightFileTokens("plain text\n", "notes.xyz")).toBeNull();
    expect(canHighlightPath("notes.xyz")).toBe(false);
    expect(canHighlightPath("Makefile")).toBe(false);
    expect(canHighlightPath("src/a.ts")).toBe(true);
  });

  it("answers null above the size cap rather than blocking on a huge file", async () => {
    // codeToTokens is synchronous over the whole file; past the cap the honest
    // trade is an uncoloured diff instead of a frozen window.
    const huge = `const a = ${"1 + ".repeat(80_000)}1;\n`;
    expect(huge.length).toBeGreaterThan(256 * 1024);
    expect(await highlightFileTokens(huge, "src/a.ts")).toBeNull();
  });

  it("answers null instead of throwing when the highlighter fails to load", async () => {
    vi.resetModules();
    vi.doMock("shiki", () => ({
      createCssVariablesTheme: vi.fn(() => ({ name: "porta-syn", tokenColors: [] })),
      createHighlighter: vi.fn(() => Promise.reject(new Error("wasm instantiation failed"))),
    }));

    const { highlightFileTokens: fresh } = await import("./diff-highlight");
    expect(await fresh("const s = '<i>';\nconst t = 2;", "src/a.ts")).toBeNull();

    vi.doUnmock("shiki");
    vi.resetModules();
  });

  it("answers null instead of throwing when tokenising throws", async () => {
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

    const { highlightFileTokens: fresh } = await import("./diff-highlight");
    expect(await fresh("const a = 1;\nconst b = 2;", "src/a.ts")).toBeNull();

    vi.doUnmock("shiki");
    vi.resetModules();
  });

  it("answers null instead of throwing when the grammar cannot be loaded", async () => {
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

    const { highlightFileTokens: fresh } = await import("./diff-highlight");
    expect(await fresh("const a = 1;", "src/a.ts")).toBeNull();

    vi.doUnmock("shiki");
    vi.resetModules();
  });

  it("tokenises one file's contents once, however many times it is asked for", async () => {
    vi.resetModules();
    let tokenised = 0;
    vi.doMock("shiki", () => ({
      createCssVariablesTheme: vi.fn(() => ({ name: "porta-syn", tokenColors: [] })),
      createHighlighter: vi.fn(() =>
        Promise.resolve({
          getLoadedLanguages: () => ["typescript"],
          loadLanguage: () => Promise.resolve(),
          codeToTokens: (code: string) => {
            tokenised += 1;
            return {
              tokens: code.split("\n").map((line) => [{ content: line, color: "var(--x)" }]),
            };
          },
        }),
      ),
    }));

    const { highlightFileTokens: fresh } = await import("./diff-highlight");
    const source = "const a = 1;\nconst b = 2;\n";

    await fresh(source, "src/a.ts");
    // A refetch that came back byte-identical: the pane regaining focus, a
    // hunk action on the other side, a staged flip that left this side alone.
    await fresh(source, "src/a.ts");
    // Two rows of the same file asking at the same moment.
    await Promise.all([fresh(source, "src/a.ts"), fresh(source, "src/a.ts")]);
    expect(tokenised).toBe(1);

    // …and content that genuinely moved — staging a hunk rewrites the index —
    // is not served the stale entry. Colouring the new diff with the old
    // file's tokens is exactly what a (path, revision) key would have done.
    await fresh(source.replace("1", "3"), "src/a.ts");
    expect(tokenised).toBe(2);

    // The same bytes under a different path are a different language question.
    await fresh(source, "src/b.ex");
    expect(tokenised).toBe(3);

    vi.doUnmock("shiki");
    vi.resetModules();
  });

  it("does not cache a failure, so the next call for that file retries", async () => {
    // highlight.ts drops its cached highlighter promise when a load fails,
    // specifically so a later call can retry rather than one bad load leaving
    // the app uncoloured for its lifetime. Caching the resulting null against
    // the content key would quietly take that back for this file.
    vi.resetModules();
    let loads = 0;
    vi.doMock("shiki", () => ({
      createCssVariablesTheme: vi.fn(() => ({ name: "porta-syn", tokenColors: [] })),
      createHighlighter: vi.fn(() => {
        loads += 1;
        if (loads === 1) return Promise.reject(new Error("wasm instantiation failed"));
        return Promise.resolve({
          getLoadedLanguages: () => ["typescript"],
          loadLanguage: () => Promise.resolve(),
          codeToTokens: (code: string) => ({
            tokens: code
              .split("\n")
              .map((line) => [{ content: line, color: "var(--shiki-token-keyword)" }]),
          }),
        });
      }),
    }));

    const { highlightFileTokens: fresh } = await import("./diff-highlight");
    const source = "const a = 1;\n";

    expect(await fresh(source, "src/a.ts")).toBeNull();
    // Same path, same bytes — the same cache key the failure arrived under.
    expect(await fresh(source, "src/a.ts")).not.toBeNull();
    expect(loads).toBe(2);

    vi.doUnmock("shiki");
    vi.resetModules();
  });
});
