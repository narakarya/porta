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
  it("never declares palette variables outside the tab root", () => {
    const selectors = css.match(/^[^\s@/][^{]*\{/gm) ?? [];
    for (const sel of selectors) {
      expect(sel.trim(), "leaked selector").toMatch(/^\.git-tab-root/);
    }
  });

  it("validates theme ids", () => {
    expect(isGitTheme("midnight")).toBe(true);
    expect(isGitTheme("chartreuse")).toBe(false);
    expect(isGitTheme(undefined)).toBe(false);
  });
});
