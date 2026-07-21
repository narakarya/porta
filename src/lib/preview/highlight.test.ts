import { describe, expect, it, vi } from "vitest";
import { langFromPath, highlightCode } from "./highlight";

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

describe("highlightCode", () => {
  it("emits token spans for a supported language", async () => {
    const html = await highlightCode("def run(x), do: {:ok, x}", "elixir");
    expect(html).toContain("<span");
    expect(html).toContain("run");
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

  it("falls back to escaped text when the highlighter fails to load, and recovers on the next call", async () => {
    vi.resetModules();
    let calls = 0;
    vi.doMock("shiki", () => ({
      createHighlighter: vi.fn(() => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("wasm instantiation failed"));
        return Promise.resolve({
          getLoadedLanguages: () => ["elixir"],
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
