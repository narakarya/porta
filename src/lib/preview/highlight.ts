import type { Highlighter } from "shiki";

/**
 * Syntax highlighting for git file previews. Replaces the extension's
 * hand-rolled highlight.js, which only tokenised a fixed set of languages —
 * Shiki covers those and more, so parity here is a floor, not a ceiling.
 *
 * Colours come from the tab's theme tokens (--syn-*), not from a Shiki theme:
 * the tab owns its palette, so we highlight with a neutral theme and let CSS
 * recolour the token classes.
 */
const EXT_TO_LANG: Record<string, string> = {
  ex: "elixir", exs: "elixir",
  rs: "rust",
  tsx: "tsx", ts: "typescript",
  jsx: "jsx", js: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  md: "markdown",
  sh: "shell", bash: "shell", zsh: "shell",
  css: "css", scss: "scss",
  html: "html",
  sql: "sql",
  py: "python",
  go: "go",
  rb: "ruby",
};

export function langFromPath(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "text"; // no extension, or a dotfile like ".gitignore"
  return EXT_TO_LANG[base.slice(dot + 1).toLowerCase()] ?? "text";
}

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({
        themes: ["github-dark-default"],
        langs: [...new Set(Object.values(EXT_TO_LANG))],
      }),
    );
  }
  return highlighterPromise;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  if (lang === "text") return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
  const highlighter = await getHighlighter();
  if (!highlighter.getLoadedLanguages().includes(lang)) {
    return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
  }
  return highlighter.codeToHtml(code, { lang, theme: "github-dark-default" });
}
