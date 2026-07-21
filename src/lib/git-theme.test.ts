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
  it("guards every color-mix() derivation behind an @supports test", () => {
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const guard = declarations.indexOf("@supports (color: color-mix(");
    expect(guard, "no @supports guard found").toBeGreaterThan(-1);
    expect(declarations.slice(0, guard), "color-mix() outside the guard").not.toContain("color-mix(");
  });

  it("validates theme ids", () => {
    expect(isGitTheme("midnight")).toBe(true);
    expect(isGitTheme("chartreuse")).toBe(false);
    expect(isGitTheme(undefined)).toBe(false);
  });
});
