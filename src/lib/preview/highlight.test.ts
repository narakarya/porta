import { describe, expect, it } from "vitest";
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
});
