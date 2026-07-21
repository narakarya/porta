import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GIT_THEMES, isGitTheme } from "./git-theme";

const css = readFileSync(resolve(__dirname, "../styles/git-theme.css"), "utf-8");

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

  // The spec's hard boundary: tab palettes must never leak into Porta's chrome.
  // Walks braces rather than matching selector lines, so the check survives
  // reformatting — a Prettier pass must not be able to turn this into either a
  // false alarm or a false pass. At-rule preludes (`@supports`, `@media`) are
  // not selectors: the walk steps *into* those blocks and checks the style
  // rules inside, so wrapping a declaration in @supports can never be a way to
  // sneak a leak past this test. Style-rule bodies hold declarations only, so
  // a flat scan for braces is enough to find every prelude.
  function styleRuleSelectors(source: string): string[] {
    const out: string[] = [];
    let prelude = "";
    for (const ch of source.replace(/\/\*[\s\S]*?\*\//g, "")) {
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
