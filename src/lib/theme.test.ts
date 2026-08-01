import { describe, it, expect, beforeEach } from "vitest";
import {
  THEMES,
  ACCENTS,
  getTheme,
  getAccent,
  resolveAccent,
  terminalTheme,
  applyTheme,
  loadThemeId,
  loadAccentId,
  rgba,
  LS_THEME,
  LS_ACCENT,
} from "./theme";

describe("rgba", () => {
  it("expands a 6-digit hex", () => {
    expect(rgba("#60a5fa", 0.16)).toBe("rgba(96, 165, 250, 0.16)");
  });

  it("expands a 3-digit hex", () => {
    expect(rgba("#000", 1)).toBe("rgba(0, 0, 0, 1)");
  });
});

describe("theme lookup", () => {
  it("falls back to the first theme for an unknown id", () => {
    expect(getTheme("nope-not-a-theme").id).toBe("porta-dark");
    expect(getTheme(null).id).toBe("porta-dark");
  });

  it("falls back to the 'theme' accent for an unknown id", () => {
    expect(getAccent("chartreuse").id).toBe("theme");
  });

  it("every theme declares a full ANSI palette", () => {
    // A missing slot silently falls back to xterm's own default, which won't
    // match the rest of the theme — cheaper to catch here.
    for (const t of THEMES) {
      const mapped = terminalTheme(t);
      for (const [k, v] of Object.entries(mapped)) {
        expect(v, `${t.id}.${k}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("theme ids and accent ids are unique", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(new Set(ACCENTS.map((a) => a.id)).size).toBe(ACCENTS.length);
  });
});

describe("resolveAccent", () => {
  const nord = getTheme("nord");

  it("uses the theme's own accent when set to 'theme'", () => {
    expect(resolveAccent(nord, getAccent("theme")).color).toBe(nord.accent);
  });

  it("a preset overrides the theme's accent", () => {
    expect(resolveAccent(nord, getAccent("rose")).color).toBe("#fb7185");
  });
});

describe("applyTheme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-theme");
  });

  it("writes the theme's surfaces and the resolved accent onto <html>", () => {
    applyTheme("dracula", "emerald");
    const s = document.documentElement.style;
    const dracula = getTheme("dracula");
    expect(s.getPropertyValue("--surface-0")).toBe(dracula.surface0);
    expect(s.getPropertyValue("--ink-1")).toBe(dracula.ink1);
    // Accent preset wins over the theme's own purple.
    expect(s.getPropertyValue("--accent")).toBe("#34d399");
    expect(s.getPropertyValue("--accent-bg")).toBe("rgba(52, 211, 153, 0.16)");
    expect(document.documentElement.dataset.theme).toBe("dracula");
  });

  it("an unknown theme id still paints a usable palette", () => {
    applyTheme("deleted-theme", "theme");
    expect(document.documentElement.style.getPropertyValue("--surface-0")).toBe(THEMES[0].surface0);
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());

  it("defaults when nothing is stored", () => {
    expect(loadThemeId()).toBe("porta-dark");
    expect(loadAccentId()).toBe("theme");
  });

  it("round-trips a stored selection", () => {
    localStorage.setItem(LS_THEME, "nord");
    localStorage.setItem(LS_ACCENT, "amber");
    expect(loadThemeId()).toBe("nord");
    expect(loadAccentId()).toBe("amber");
  });

  it("ignores a stored id that no longer exists", () => {
    localStorage.setItem(LS_THEME, "solarized-from-a-future-release");
    expect(loadThemeId()).toBe("porta-dark");
  });
});
