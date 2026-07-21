import type { BundledLanguage, Highlighter, ThemeRegistration } from "shiki";

/**
 * Syntax highlighting for git file previews. Replaces the extension's
 * hand-rolled highlight.js, which only tokenised a fixed set of languages —
 * Shiki covers those and more, so parity here is a floor, not a ceiling.
 *
 * Colours come from the tab's theme tokens (--syn-*), not from a Shiki theme.
 * Shiki bakes a theme's colours into per-token inline styles, which no
 * class-based CSS can override, so a normal theme would pin every preview to
 * that theme's palette — a GitHub-dark box sitting on `paper`'s cream. Instead
 * we highlight with Shiki's css-variables theme: the inline styles then read
 * `var(--shiki-token-*)`, and src/styles/git-theme.css binds those to the
 * palette's --syn-* tokens under .git-tab-root. That bridge is the only place
 * the two vocabularies meet; nothing here knows a palette exists.
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

/** Every language id this module can actually highlight. */
const SUPPORTED_LANGS: ReadonlySet<string> = new Set(Object.values(EXT_TO_LANG));

/**
 * Fence info strings carry language *names*, not file extensions, so the
 * extension map alone leaves ```sh unhighlighted while ```shell works. The
 * extension names double as fence aliases (js, ts, yml, rb, …); the rest below
 * are the names markdown authors write that have no matching extension.
 */
const FENCE_ALIASES: Record<string, string> = {
  ...EXT_TO_LANG,
  shellscript: "shell", console: "shell", sh: "shell", bash: "shell", zsh: "shell",
  golang: "go",
  jsonc: "json", json5: "json",
  htm: "html",
  markdown: "markdown",
  plaintext: "text", txt: "text", text: "text", plain: "text",
};

export function langFromPath(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "text"; // no extension, or a dotfile like ".gitignore"
  return EXT_TO_LANG[base.slice(dot + 1).toLowerCase()] ?? "text";
}

/**
 * Resolves a fenced block's info string to the same language ids langFromPath
 * produces. Returns "text" for anything unsupported, which highlightCode
 * renders as escaped plain text.
 */
export function langFromFence(info: string): string {
  const name = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!name) return "text";
  const mapped = FENCE_ALIASES[name];
  if (mapped) return mapped;
  return SUPPORTED_LANGS.has(name) ? name : "text";
}

/**
 * Whether a resolved language id will be highlighted rather than rendered as
 * plain text. Exported so a caller can tell the two apart up front — labelling
 * a block, warning, offering a fallback — instead of inferring it from markup.
 */
export function isSupportedLang(lang: string): boolean {
  return SUPPORTED_LANGS.has(lang);
}

/** The theme name Shiki tags the <pre> with; also the class on plain() output. */
export const SYN_THEME_NAME = "porta-syn";

/**
 * Shiki's css-variables theme covers keyword/string/comment/function directly,
 * but folds numbers, atoms and type names into one `token-constant` bucket and
 * routes type names through `token-function`. The palette names all seven, so
 * these three rules split the bucket back out. Appended last: for equally
 * specific scope selectors, the later rule wins.
 */
function buildTheme(create: (opts: { name: string }) => ThemeRegistration): ThemeRegistration {
  const theme = create({ name: SYN_THEME_NAME });
  theme.tokenColors = [
    ...(theme.tokenColors ?? []),
    {
      scope: ["constant.numeric"],
      settings: { foreground: "var(--shiki-token-number)" },
    },
    {
      scope: [
        "entity.name.type", "entity.name.class", "entity.name.namespace",
        "entity.name.module", "entity.other.inherited-class",
        "support.type", "support.class",
      ],
      settings: { foreground: "var(--shiki-token-type)" },
    },
    {
      scope: [
        "constant.language", "constant.character", "constant.other.symbol",
        "constant.other.keyword", "variable.language",
      ],
      settings: { foreground: "var(--shiki-token-atom)" },
    },
  ];
  return theme;
}

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({
        themes: [buildTheme(shiki.createCssVariablesTheme)],
        // No grammars up front. Eighteen of them cost a visible stall on the
        // first preview in a WKWebView; each block loads only what it needs.
        langs: [],
      }),
    );
  }
  return highlighterPromise;
}

// Deduped per language so two blocks of the same language in one document (or
// two documents in flight) never load the same grammar twice. Keyed on the
// highlighter, not global: after a failed load is retried the replacement
// instance has no grammars, and a global map would tell it otherwise.
const langLoads = new WeakMap<Highlighter, Map<string, Promise<boolean>>>();

function ensureLanguage(highlighter: Highlighter, lang: string): Promise<boolean> {
  if (highlighter.getLoadedLanguages().includes(lang)) return Promise.resolve(true);
  let loads = langLoads.get(highlighter);
  if (!loads) {
    loads = new Map();
    langLoads.set(highlighter, loads);
  }
  let pending = loads.get(lang);
  if (!pending) {
    pending = highlighter
      .loadLanguage(lang as BundledLanguage)
      .then(() => true)
      // A grammar Shiki doesn't ship, or one that fails to parse, is a missing
      // nicety — not a reason to reject out of a preview render.
      .catch(() => false);
    loads.set(lang, pending);
  }
  return pending;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The unhighlighted fallback. Deliberately the same shape Shiki emits — same
 * wrapper classes, same line spans, same variable-driven inline style — so a
 * fallback and a success are the same component with different colours inside,
 * not two different-looking boxes in one list.
 */
function plain(code: string): string {
  const lines = code.split("\n").map((line) => `<span class="line">${escapeHtml(line)}</span>`);
  return (
    `<pre class="shiki ${SYN_THEME_NAME}" ` +
    `style="background-color:var(--shiki-background);color:var(--shiki-foreground)" ` +
    `tabindex="0"><code>${lines.join("\n")}</code></pre>`
  );
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  if (lang === "text" || !SUPPORTED_LANGS.has(lang)) return plain(code);

  const loading = getHighlighter();
  let highlighter: Highlighter;
  try {
    highlighter = await loading;
  } catch {
    // The *load* failed — a WASM instantiation that never resolves in the
    // webview, a bad chunk. Drop the cached promise so a later call can retry
    // instead of one bad load disabling highlighting for the app's lifetime,
    // but only if nothing has since replaced it with a working one.
    if (highlighterPromise === loading) highlighterPromise = null;
    return plain(code);
  }

  try {
    if (!(await ensureLanguage(highlighter, lang))) return plain(code);
    return highlighter.codeToHtml(code, { lang, theme: SYN_THEME_NAME });
  } catch {
    // Tokenising blew up on this block. The highlighter itself is fine, so it
    // stays cached — throwing it away would make one bad block cost a full
    // reload on the next one.
    return plain(code);
  }
}
