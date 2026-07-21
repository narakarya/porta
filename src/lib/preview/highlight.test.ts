import { describe, expect, it, vi } from "vitest";
import { langFromPath, langFromFence, isSupportedLang, highlightCode } from "./highlight";

// The extension's highlight.js recognised these; core must not regress on them.
describe("langFromPath", () => {
  it.each([
    ["lib/porta/app.ex", "elixir"],
    ["mix.exs", "elixir"],
    ["src/main.rs", "rust"],
    ["src/App.tsx", "tsx"],
    ["src/lib/commands.ts", "typescript"],
    ["vite.config.js", "javascript"],
    ["package.json", "json"],
    ["config/porta.yaml", "yaml"],
    ["README.md", "markdown"],
    ["scripts/build.sh", "shell"],
    ["src/index.css", "css"],
    ["index.html", "html"],
  ])("maps %s to %s", (path, lang) => {
    expect(langFromPath(path)).toBe(lang);
  });

  it("falls back to text for unknown extensions", () => {
    expect(langFromPath("notes.xyz")).toBe("text");
  });

  it("falls back to text for a file with no extension", () => {
    expect(langFromPath("Makefile")).toBe("text");
  });
});

// Fences carry language *names*; langFromPath only knows extensions. Without a
// normaliser ```sh renders unhighlighted while ```shell works.
describe("langFromFence", () => {
  it.each([
    ["sh", "shell"],
    ["bash", "shell"],
    ["zsh", "shell"],
    ["shell", "shell"],
    ["shellscript", "shell"],
    ["console", "shell"],
    ["js", "javascript"],
    ["javascript", "javascript"],
    ["ts", "typescript"],
    ["tsx", "tsx"],
    ["jsx", "jsx"],
    ["yml", "yaml"],
    ["yaml", "yaml"],
    ["rs", "rust"],
    ["rust", "rust"],
    ["py", "python"],
    ["python", "python"],
    ["md", "markdown"],
    ["markdown", "markdown"],
    ["ex", "elixir"],
    ["exs", "elixir"],
    ["elixir", "elixir"],
    ["rb", "ruby"],
    ["go", "go"],
    ["golang", "go"],
  ])("resolves the %s fence to %s", (name, lang) => {
    expect(langFromFence(name)).toBe(lang);
  });

  it("agrees with langFromPath on every extension it shares", () => {
    for (const path of ["a.ex", "a.rs", "a.tsx", "a.ts", "a.js", "a.yml", "a.sh", "a.rb", "a.py"]) {
      const ext = path.slice(path.indexOf(".") + 1);
      expect(langFromFence(ext), ext).toBe(langFromPath(path));
    }
  });

  it("ignores the rest of the info string", () => {
    expect(langFromFence("elixir title=example.ex")).toBe("elixir");
  });

  it("returns text for an empty or unsupported fence", () => {
    expect(langFromFence("")).toBe("text");
    expect(langFromFence("cobol")).toBe("text");
    expect(langFromFence("plaintext")).toBe("text");
  });

  it("lets a caller tell supported from unsupported up front", () => {
    expect(isSupportedLang("elixir")).toBe(true);
    expect(isSupportedLang("text")).toBe(false);
    expect(isSupportedLang(langFromFence("cobol"))).toBe(false);
  });
});

describe("highlightCode", () => {
  it("emits token spans for a supported language", async () => {
    const html = await highlightCode("def run(x), do: {:ok, x}", "elixir");
    expect(html).toContain("<span");
    expect(html).toContain("run");
  });

  // The point of the whole css-variables setup. Shiki's default output carries
  // per-token inline colours, which no class-based CSS can override — with them
  // every --syn-* token in git-theme.css is dead and `paper` renders a
  // GitHub-dark box on cream. Asserting "some span exists" would not notice a
  // regression back to that, so assert on the absence of literal colour.
  it("emits no hardcoded colour anywhere in its output", async () => {
    const html = await highlightCode(
      "defmodule Foo do\n  def run(x), do: {:ok, x + 1} # go\nend",
      "elixir",
    );
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\brgba?\(/);
    expect(html).not.toMatch(/color:\s*(?!var\()/);
  });

  it("resolves every token colour through a --syn-backed variable", async () => {
    const html = await highlightCode(
      "defmodule Foo do\n  def run(x), do: {:ok, x + 1} # go\nend",
      "elixir",
    );
    // Every colour Shiki writes must be a var() the theme bridge binds.
    const colours = [...html.matchAll(/color:(var\([^)]*\)|[^";]+)/g)].map((m) => m[1]);
    expect(colours.length).toBeGreaterThan(3);
    for (const colour of colours) {
      expect(colour, "inline colour").toMatch(/^var\(--shiki-(foreground|background|token-[a-z-]+)\)$/);
    }
    // …and the roles this snippet exercises must be the distinct ones the
    // palette names, not one merged bucket.
    for (const role of ["keyword", "function", "comment", "number", "type", "atom"]) {
      expect(html, `--shiki-token-${role}`).toContain(`var(--shiki-token-${role})`);
    }
  });

  it("gives the unhighlighted fallback the same shape as a highlighted block", async () => {
    const highlighted = await highlightCode("def run(x), do: x\n:ok", "elixir");
    const fallback = await highlightCode("def run(x), do: x\n:ok", "text");

    for (const marker of ['class="shiki porta-syn"', 'tabindex="0"', '<span class="line">']) {
      expect(fallback, marker).toContain(marker);
      expect(highlighted, marker).toContain(marker);
    }
    // One <span class="line"> per source line on both sides.
    const lines = (html: string) => (html.match(/<span class="line">/g) ?? []).length;
    expect(lines(fallback)).toBe(lines(highlighted));
  });

  it("still returns escaped code for an unsupported language", async () => {
    const html = await highlightCode("<script>alert(1)</script>", "text");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns escaped code for a language id that was never loaded", async () => {
    const html = await highlightCode("<script>alert(1)</script>", "cobol");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("loads grammars on demand rather than all eighteen up front", async () => {
    vi.resetModules();
    const loaded: string[] = [];
    let requestedLangs: unknown;
    vi.doMock("shiki", () => ({
      createCssVariablesTheme: vi.fn(() => ({ name: "porta-syn", tokenColors: [] })),
      createHighlighter: vi.fn((opts: { langs: unknown }) => {
        requestedLangs = opts.langs;
        return Promise.resolve({
          getLoadedLanguages: () => [...loaded],
          loadLanguage: (lang: string) => {
            loaded.push(lang);
            return Promise.resolve();
          },
          codeToHtml: (code: string) => `<pre class="shiki"><code><span>${code}</span></code></pre>`,
        });
      }),
    }));

    const { highlightCode: fresh } = await import("./highlight");
    await fresh("def a, do: 1", "elixir");
    expect(requestedLangs).toEqual([]);
    expect(loaded).toEqual(["elixir"]);

    await fresh("def b, do: 2", "elixir");
    await fresh("fn main() {}", "rust");
    // elixir is loaded once, not once per block.
    expect(loaded).toEqual(["elixir", "rust"]);

    vi.doUnmock("shiki");
    vi.resetModules();
  });

  it("keeps a working highlighter when a single block fails to tokenise", async () => {
    vi.resetModules();
    let created = 0;
    let calls = 0;
    vi.doMock("shiki", () => ({
      createCssVariablesTheme: vi.fn(() => ({ name: "porta-syn", tokenColors: [] })),
      createHighlighter: vi.fn(() => {
        created++;
        return Promise.resolve({
          getLoadedLanguages: () => ["elixir"],
          loadLanguage: () => Promise.resolve(),
          codeToHtml: (code: string) => {
            if (++calls === 1) throw new Error("grammar blew up");
            return `<pre class="shiki"><code><span>${code}</span></code></pre>`;
          },
        });
      }),
    }));

    const { highlightCode: fresh } = await import("./highlight");

    const failed = await fresh("<script>alert(1)</script>", "elixir");
    expect(failed).toContain("&lt;script&gt;");

    const next = await fresh("def run(x), do: x", "elixir");
    expect(next).toContain("<span>");
    // The load succeeded; only tokenising failed. Reloading would be wasted work.
    expect(created).toBe(1);

    vi.doUnmock("shiki");
    vi.resetModules();
  });

  it("falls back to escaped text when the highlighter fails to load, and recovers on the next call", async () => {
    vi.resetModules();
    let calls = 0;
    vi.doMock("shiki", () => ({
      createCssVariablesTheme: vi.fn(() => ({ name: "porta-syn", tokenColors: [] })),
      createHighlighter: vi.fn(() => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("wasm instantiation failed"));
        return Promise.resolve({
          getLoadedLanguages: () => ["elixir"],
          loadLanguage: () => Promise.resolve(),
          codeToHtml: (code: string) =>
            `<pre class="shiki"><code><span>${code}</span></code></pre>`,
        });
      }),
    }));

    const { highlightCode: freshHighlightCode } = await import("./highlight");

    const failed = await freshHighlightCode("<script>alert(1)</script>", "elixir");
    expect(failed).not.toContain("<script>");
    expect(failed).toContain("&lt;script&gt;");

    const recovered = await freshHighlightCode("def run(x), do: x", "elixir");
    expect(recovered).toContain("<span>");
    expect(calls).toBe(2);

    vi.doUnmock("shiki");
    vi.resetModules();
  });
});
