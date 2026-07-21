import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GIT_THEMES, isGitTheme } from "./git-theme";

const styles = resolve(__dirname, "../styles");
const css = readFileSync(resolve(styles, "git-theme.css"), "utf-8");
// Read lazily so a missing file fails only the stylesheet suite below, instead
// of taking the palette assertions down with it at collect time.
const previewCss = () => readFileSync(resolve(styles, "git-preview.css"), "utf-8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

// The spec's hard boundary: tab palettes must never leak into Porta's chrome.
// Walks braces rather than matching selector lines, so the check survives
// reformatting — a Prettier pass must not be able to turn this into either a
// false alarm or a false pass. At-rule preludes (`@supports`, `@media`) are
// not selectors: the walk steps *into* those blocks and checks the style
// rules inside, so wrapping a declaration in @supports can never be a way to
// sneak a leak past this test. Style-rule bodies hold declarations only, so
// a flat scan for braces is enough to find every prelude.
//
// Module scope rather than suite scope because both stylesheets are checked
// with it; one parser, two files.
function styleRuleSelectors(source: string): string[] {
  const out: string[] = [];
  let prelude = "";
  for (const ch of stripComments(source)) {
    if (ch === "{") {
      const rule = prelude.trim();
      // `@…` opens a conditional group — descend, don't record.
      if (!rule.startsWith("@")) out.push(...rule.split(",").map((s) => s.trim()).filter(Boolean));
      prelude = "";
    } else if (ch === "}") {
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  return out;
}

/** Tokens a stylesheet *declares* — `--md-heading: #fff` — for one prefix. */
function declaredTokens(source: string, prefix: string): string[] {
  const re = new RegExp(`(--${prefix}-[a-z0-9-]+)\\s*:`, "g");
  return [...new Set(Array.from(stripComments(source).matchAll(re), (m) => m[1]))];
}

/** Tokens a stylesheet *reads* — every `var(--x)` substitution in it. */
function referencedTokens(source: string): Set<string> {
  return new Set(
    Array.from(stripComments(source).matchAll(/var\(\s*(--[a-z0-9-]+)/g), (m) => m[1]),
  );
}

describe("git theme palettes", () => {
  it("offers the same seven palettes as the extension", () => {
    expect(GIT_THEMES.map((t) => t.id)).toEqual([
      "dark", "graphite", "soft-dark", "midnight", "paper", "forest", "sunset",
    ]);
  });

  it("has a stylesheet block for every non-default palette", () => {
    for (const { id } of GIT_THEMES.filter((t) => t.id !== "dark")) {
      expect(css, `palette ${id}`).toContain(`.git-tab-root[data-git-theme="${id}"]`);
    }
  });

  it("never declares palette variables outside the tab root", () => {
    const selectors = styleRuleSelectors(css);

    expect(selectors.length, "found no selectors to check").toBeGreaterThan(0);
    for (const sel of selectors) {
      expect(sel, "leaked selector").toMatch(/^\.git-tab-root/);
    }
  });

  // Proof the walk really does look inside a conditional group, so the test
  // above stays a boundary check and not a formality.
  it("catches a leak nested inside an at-rule", () => {
    const leaky = "@supports (color: color-mix(in srgb, red, blue)) { :root { --accent: red; } }";
    expect(styleRuleSelectors(leaky)).toEqual([":root"]);
  });

  // color-mix() needs WKWebView 16.2+; unguarded, the derived tokens shadow
  // Porta's :root values with something that computes to `unset` on an older
  // engine, which reads as transparent rather than as the previous colour.
  //
  // Every occurrence is checked, not just the text before the first guard: a
  // declaration added *after* the guard block is exactly as unguarded as one
  // added before it, and is the likelier mistake. Same brace walk as above, so
  // reformatting can't turn it into a false pass; an occurrence counts as
  // guarded when some enclosing block is an `@supports` whose own test is a
  // color-mix() (the guard writing its own test doesn't count as a use).
  function unguardedColorMix(source: string): string[] {
    const declarations = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const out: string[] = [];
    const open: string[] = [];
    let prelude = "";
    for (let i = 0; i < declarations.length; i++) {
      const ch = declarations[i];
      if (ch === "{") {
        open.push(prelude.trim());
        prelude = "";
        continue;
      }
      if (ch === "}") {
        open.pop();
        prelude = "";
        continue;
      }
      prelude += ch;
      if (!declarations.startsWith("color-mix(", i)) continue;
      const isGuardTest = prelude.trimStart().startsWith("@supports");
      const guarded = open.some((p) => p.startsWith("@supports") && p.includes("color-mix("));
      if (!isGuardTest && !guarded) out.push(declarations.slice(i, i + 60).split("\n")[0]);
    }
    return out;
  }

  it("guards every color-mix() derivation behind an @supports test", () => {
    expect(css).toContain("@supports (color: color-mix(");
    expect(unguardedColorMix(css), "color-mix() outside the guard").toEqual([]);
  });

  // Proof the walk above is a real check: an occurrence *after* the guard block
  // is what the old "nothing precedes the first guard" assertion let through.
  it("catches a color-mix() added after the guard block", () => {
    const guard = "@supports (color: color-mix(in srgb, red, blue)) { .git-tab-root { --a: color-mix(in srgb, red, blue); } }";
    expect(unguardedColorMix(guard)).toEqual([]);
    expect(
      unguardedColorMix(`${guard}\n.git-tab-root { --b: color-mix(in srgb, red, blue); }`),
    ).toHaveLength(1);
  });

  it("validates theme ids", () => {
    expect(isGitTheme("midnight")).toBe(true);
    expect(isGitTheme("chartreuse")).toBe(false);
    expect(isGitTheme(undefined)).toBe(false);
  });
});

describe("git preview stylesheet", () => {
  // Same boundary as the palettes: git-preview.css is imported globally from
  // src/index.css, so an unscoped `h1` or `table` rule in it would restyle
  // every heading and table in Porta's chrome.
  it("never styles anything outside the tab root", () => {
    const selectors = styleRuleSelectors(previewCss());

    expect(selectors.length, "found no selectors to check").toBeGreaterThan(0);
    for (const sel of selectors) {
      expect(sel, "leaked selector").toMatch(/^\.git-tab-root\b/);
    }
  });

  // The check this task exists for. Every palette in git-theme.css defines the
  // --md-* family, and before this stylesheet not one rule anywhere read them:
  // seven palettes' worth of markdown colour that styled nothing. Asserting
  // *consumption* rather than mere presence is what keeps that from recurring —
  // delete a rule here and the token it read goes unreferenced, and this fails.
  it("consumes every --md-* token the palettes define", () => {
    const declared = declaredTokens(css, "md");
    const used = referencedTokens(previewCss());

    expect(declared.length, "no --md-* tokens found in git-theme.css").toBeGreaterThan(0);
    expect(declared.filter((t) => !used.has(t)), "declared but never read").toEqual([]);
  });

  // --syn-* is the same rule with one indirection: Shiki writes token colours
  // as inline `var(--shiki-token-*)` styles, so git-theme.css already binds
  // every --syn-* to a --shiki-token-* there rather than here. Either file
  // counts as consumption; what must not exist is a palette colour no rule in
  // the tab reads at all.
  it("consumes every --syn-* token the palettes define", () => {
    const declared = declaredTokens(css, "syn");
    const used = new Set([...referencedTokens(css), ...referencedTokens(previewCss())]);

    expect(declared.length, "no --syn-* tokens found in git-theme.css").toBeGreaterThan(0);
    expect(declared.filter((t) => !used.has(t)), "declared but never read").toEqual([]);
  });

  // Proof the two assertions above can actually fail — a token-coverage test
  // that only ever sees a passing corpus is indistinguishable from no test.
  it("catches a token that is declared but never read", () => {
    const palette = ".git-tab-root { --md-heading: #fff; --md-link: #7dd3fc; }";
    const rules = ".git-tab-root .md-body h1 { color: var(--md-heading); }";
    const declared = declaredTokens(palette, "md");
    const used = referencedTokens(rules);

    expect(declared.filter((t) => !used.has(t))).toEqual(["--md-link"]);
  });

  // The renderer's own markers, straight from src/lib/preview: markdown.ts
  // emits .md-pre / .md-pre-lang / .md-check / .md-mermaid, mermaid.ts adds
  // .md-mermaid-error, and highlight.ts emits .shiki. A stylesheet that misses
  // one leaves that element on Tailwind's preflight reset.
  it("styles every marker the preview pipeline emits", () => {
    const source = previewCss();
    for (const marker of [
      ".md-pre", ".md-pre-lang", ".md-check", ".md-mermaid", ".md-mermaid-error", ".shiki",
    ]) {
      expect(source, `unstyled marker ${marker}`).toContain(marker);
    }
    // The badge is a pseudo-element on the <pre> itself: Shiki's <pre> replaces
    // markdown-it's wholesale (preview/index.ts), so a sibling <span> badge
    // would be left pointing at an element that no longer exists.
    expect(source).toContain("content: attr(data-lang)");
  });
});
