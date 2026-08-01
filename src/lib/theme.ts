/**
 * Theme registry + applier.
 *
 * A theme is nothing but a set of values for the CSS custom properties declared
 * in `src/index.css` — the same vars Tailwind's semantic utilities resolve to
 * (see `tailwind.config.js`). Applying one writes those vars onto
 * `<html>`; every `bg-surface-1` / `text-ink-2` / `border-subtle` in the app
 * follows automatically. Nothing here touches component code.
 *
 * Themes are dark-only for now. A light theme needs the `white/[0.0x]` hover
 * overlays to become an invertible token first, so it isn't just another entry
 * in this table.
 *
 * Palettes are the upstream projects' published values (Tokyo Night,
 * Catppuccin Mocha, Nord, Dracula, Gruvbox, One Dark), mapped onto Porta's
 * roles rather than copied wholesale — Porta needs three surface steps and
 * three ink steps, which most editor themes don't name the same way.
 */

export type ThemeId =
  | "porta-dark"
  | "dim"
  | "midnight"
  | "tokyo-night"
  | "catppuccin-mocha"
  | "nord"
  | "dracula"
  | "gruvbox-dark"
  | "one-dark";

export type AccentId =
  | "theme"
  | "blue"
  | "violet"
  | "emerald"
  | "amber"
  | "rose"
  | "cyan"
  | "graphite";

/** The 16 ANSI slots xterm.js wants, plus the two it needs for the viewport. */
export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  selection: string;
}

export interface Theme {
  id: ThemeId;
  name: string;
  /** One line shown under the name in Settings → Appearance. */
  blurb: string;
  surface0: string;
  surface1: string;
  surface2: string;
  surfaceInput: string;
  surfaceCode: string;
  ink1: string;
  ink2: string;
  ink3: string;
  borderSubtle: string;
  borderStrong: string;
  /** The theme's signature accent, used when the accent picker is on "Theme". */
  accent: string;
  accentInk: string;
  success: string;
  warning: string;
  danger: string;
  ansi: AnsiPalette;
}

/** `#rrggbb` → `rgba(r, g, b, a)`. Alpha-bearing tints (`--accent-bg`,
 *  `--border-subtle`) are derived rather than spelled out per theme. */
export function rgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const THEMES: Theme[] = [
  {
    id: "porta-dark",
    name: "Porta Dark",
    blurb: "The default — near-black, blue accent.",
    surface0: "#0d0d0f",
    surface1: "#151517",
    surface2: "#1a1a1c",
    surfaceInput: "#111113",
    surfaceCode: "#0d0d0f",
    ink1: "#e7e7ea",
    ink2: "#b6b6bb",
    ink3: "#78787d",
    borderSubtle: "rgba(255, 255, 255, 0.085)",
    borderStrong: "rgba(255, 255, 255, 0.18)",
    accent: "#60a5fa",
    accentInk: "#bfdbfe",
    success: "#34d399",
    warning: "#fbbf24",
    danger: "#f87171",
    ansi: {
      black: "#1e1e20", red: "#f87171", green: "#4ade80", yellow: "#fbbf24",
      blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#d4d4d4",
      brightBlack: "#52525b", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde68a",
      brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#f4f4f5",
      selection: "#3f3f46",
    },
  },
  {
    id: "dim",
    name: "Dim",
    blurb: "Same palette, lifted off pure black. Easier in a bright room.",
    surface0: "#1b1b1f",
    surface1: "#212127",
    surface2: "#26262d",
    surfaceInput: "#1e1e23",
    surfaceCode: "#1b1b1f",
    ink1: "#e4e4e9",
    ink2: "#b0b0ba",
    ink3: "#7c7c88",
    borderSubtle: "rgba(255, 255, 255, 0.075)",
    borderStrong: "rgba(255, 255, 255, 0.16)",
    accent: "#7cb2fb",
    accentInk: "#cbe0fe",
    success: "#4ade80",
    warning: "#fcc94f",
    danger: "#f98a8a",
    ansi: {
      black: "#2a2a31", red: "#f98a8a", green: "#5ee08e", yellow: "#fcc94f",
      blue: "#7cb2fb", magenta: "#c9a0fb", cyan: "#3fd9e8", white: "#d7d7dc",
      brightBlack: "#5c5c68", brightRed: "#fcaeae", brightGreen: "#93efb5", brightYellow: "#fde08a",
      brightBlue: "#a5cbfd", brightMagenta: "#dcbcfd", brightCyan: "#7de9f4", brightWhite: "#f5f5f7",
      selection: "#45454f",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    blurb: "True black. Cuts power draw on OLED displays.",
    surface0: "#000000",
    surface1: "#0a0a0c",
    surface2: "#101013",
    surfaceInput: "#08080a",
    surfaceCode: "#000000",
    ink1: "#ededf2",
    ink2: "#b4b4bd",
    ink3: "#71717d",
    borderSubtle: "rgba(255, 255, 255, 0.10)",
    borderStrong: "rgba(255, 255, 255, 0.20)",
    accent: "#5eead4",
    accentInk: "#99f6e4",
    success: "#34d399",
    warning: "#fbbf24",
    danger: "#f87171",
    ansi: {
      black: "#18181b", red: "#f87171", green: "#4ade80", yellow: "#fbbf24",
      blue: "#60a5fa", magenta: "#c084fc", cyan: "#5eead4", white: "#d4d4d4",
      brightBlack: "#52525b", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde68a",
      brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#99f6e4", brightWhite: "#fafafa",
      selection: "#333338",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    blurb: "Cool indigo blues. Ported from the editor theme.",
    surface0: "#16161e",
    surface1: "#1a1b26",
    surface2: "#1f2335",
    surfaceInput: "#13131a",
    surfaceCode: "#16161e",
    ink1: "#c0caf5",
    ink2: "#a9b1d6",
    ink3: "#565f89",
    borderSubtle: "rgba(192, 202, 245, 0.09)",
    borderStrong: "rgba(192, 202, 245, 0.20)",
    accent: "#7aa2f7",
    accentInk: "#b4cbfa",
    success: "#9ece6a",
    warning: "#e0af68",
    danger: "#f7768e",
    ansi: {
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#ff7a93", brightGreen: "#b9f27c", brightYellow: "#ff9e64",
      brightBlue: "#7da6ff", brightMagenta: "#bb9af7", brightCyan: "#0db9d7", brightWhite: "#c0caf5",
      selection: "#283457",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    blurb: "Soft pastels on a warm plum base.",
    surface0: "#1e1e2e",
    surface1: "#24243a",
    surface2: "#2b2b40",
    surfaceInput: "#181825",
    surfaceCode: "#11111b",
    ink1: "#cdd6f4",
    ink2: "#a6adc8",
    ink3: "#7f849c",
    borderSubtle: "rgba(205, 214, 244, 0.09)",
    borderStrong: "rgba(205, 214, 244, 0.20)",
    accent: "#89b4fa",
    accentInk: "#b8d0fc",
    success: "#a6e3a1",
    warning: "#f9e2af",
    danger: "#f38ba8",
    ansi: {
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#cba6f7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
      brightBlue: "#89b4fa", brightMagenta: "#cba6f7", brightCyan: "#94e2d5", brightWhite: "#cdd6f4",
      selection: "#414458",
    },
  },
  {
    id: "nord",
    name: "Nord",
    blurb: "Arctic, muted blue-greys. The lightest of the dark set.",
    surface0: "#2e3440",
    surface1: "#343b48",
    surface2: "#3b4252",
    surfaceInput: "#2b313c",
    surfaceCode: "#2e3440",
    ink1: "#eceff4",
    ink2: "#d8dee9",
    ink3: "#8d97a6",
    borderSubtle: "rgba(236, 239, 244, 0.10)",
    borderStrong: "rgba(236, 239, 244, 0.22)",
    accent: "#88c0d0",
    accentInk: "#b8dae3",
    success: "#a3be8c",
    warning: "#ebcb8b",
    danger: "#bf616a",
    ansi: {
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
      selection: "#434c5e",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    blurb: "High-contrast neons on deep violet.",
    surface0: "#282a36",
    surface1: "#2f3140",
    surface2: "#383a4a",
    surfaceInput: "#21222c",
    surfaceCode: "#282a36",
    ink1: "#f8f8f2",
    ink2: "#d3d3cf",
    ink3: "#6272a4",
    borderSubtle: "rgba(248, 248, 242, 0.09)",
    borderStrong: "rgba(248, 248, 242, 0.20)",
    accent: "#bd93f9",
    accentInk: "#d6bcfb",
    success: "#50fa7b",
    warning: "#f1fa8c",
    danger: "#ff5555",
    ansi: {
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
      brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
      selection: "#44475a",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    blurb: "Warm retro earth tones, low blue light.",
    surface0: "#1d2021",
    surface1: "#282828",
    surface2: "#32302f",
    surfaceInput: "#1b1b1b",
    surfaceCode: "#1d2021",
    ink1: "#ebdbb2",
    ink2: "#bdae93",
    ink3: "#928374",
    borderSubtle: "rgba(235, 219, 178, 0.09)",
    borderStrong: "rgba(235, 219, 178, 0.20)",
    accent: "#83a598",
    accentInk: "#b3cbc2",
    success: "#b8bb26",
    warning: "#fabd2f",
    danger: "#fb4934",
    ansi: {
      black: "#282828", red: "#fb4934", green: "#b8bb26", yellow: "#fabd2f",
      blue: "#83a598", magenta: "#d3869b", cyan: "#8ec07c", white: "#ebdbb2",
      brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26", brightYellow: "#fabd2f",
      brightBlue: "#83a598", brightMagenta: "#d3869b", brightCyan: "#8ec07c", brightWhite: "#fbf1c7",
      selection: "#504945",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    blurb: "The Atom classic. Neutral slate, balanced contrast.",
    surface0: "#21252b",
    surface1: "#282c34",
    surface2: "#2f343d",
    surfaceInput: "#1e2227",
    surfaceCode: "#21252b",
    ink1: "#dfe3ea",
    ink2: "#abb2bf",
    ink3: "#7f8695",
    borderSubtle: "rgba(223, 227, 234, 0.09)",
    borderStrong: "rgba(223, 227, 234, 0.20)",
    accent: "#61afef",
    accentInk: "#a5d2f5",
    success: "#98c379",
    warning: "#e5c07b",
    danger: "#e06c75",
    ansi: {
      black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b",
      brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
      selection: "#3e4451",
    },
  },
];

export interface AccentPreset {
  id: AccentId;
  name: string;
  /** null = inherit whatever the active theme declares. */
  color: string | null;
  ink: string | null;
}

export const ACCENTS: AccentPreset[] = [
  { id: "theme", name: "Theme default", color: null, ink: null },
  { id: "blue", name: "Blue", color: "#60a5fa", ink: "#bfdbfe" },
  { id: "violet", name: "Violet", color: "#a78bfa", ink: "#ddd6fe" },
  { id: "emerald", name: "Emerald", color: "#34d399", ink: "#a7f3d0" },
  { id: "amber", name: "Amber", color: "#fbbf24", ink: "#fde68a" },
  { id: "rose", name: "Rose", color: "#fb7185", ink: "#fecdd3" },
  { id: "cyan", name: "Cyan", color: "#22d3ee", ink: "#a5f3fc" },
  { id: "graphite", name: "Graphite", color: "#a1a1aa", ink: "#e4e4e7" },
];

export const DEFAULT_THEME: ThemeId = "porta-dark";
export const DEFAULT_ACCENT: AccentId = "theme";

export function getTheme(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function getAccent(id: string | null | undefined): AccentPreset {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}

/** The accent actually in force: the preset, or the theme's own when on "theme". */
export function resolveAccent(theme: Theme, accent: AccentPreset): { color: string; ink: string } {
  return {
    color: accent.color ?? theme.accent,
    ink: accent.ink ?? theme.accentInk,
  };
}

/** xterm.js `ITheme` for the given theme — the terminal has its own colour
 *  model, so it can't read the CSS vars. Callers pass the result straight to
 *  `new Terminal({ theme })` or `term.options.theme`. */
export function terminalTheme(theme: Theme): Record<string, string> {
  const a = theme.ansi;
  return {
    background: theme.surfaceCode,
    foreground: theme.ink1,
    cursor: theme.ink2,
    black: a.black,
    red: a.red,
    green: a.green,
    yellow: a.yellow,
    blue: a.blue,
    magenta: a.magenta,
    cyan: a.cyan,
    white: a.white,
    brightBlack: a.brightBlack,
    brightRed: a.brightRed,
    brightGreen: a.brightGreen,
    brightYellow: a.brightYellow,
    brightBlue: a.brightBlue,
    brightMagenta: a.brightMagenta,
    brightCyan: a.brightCyan,
    brightWhite: a.brightWhite,
    selectionBackground: a.selection,
  };
}

/**
 * Write a theme's tokens onto `<html>`. Called on boot (from `main.tsx`, before
 * React mounts, so there's no flash of the default palette) and again whenever
 * the user picks a different theme or accent.
 */
export function applyTheme(themeId: string, accentId: string): void {
  if (typeof document === "undefined") return;
  const theme = getTheme(themeId);
  const accent = resolveAccent(theme, getAccent(accentId));
  const s = document.documentElement.style;

  s.setProperty("--surface-0", theme.surface0);
  s.setProperty("--surface-1", theme.surface1);
  s.setProperty("--surface-2", theme.surface2);
  s.setProperty("--surface-input", theme.surfaceInput);
  s.setProperty("--surface-code", theme.surfaceCode);

  s.setProperty("--ink-1", theme.ink1);
  s.setProperty("--ink-2", theme.ink2);
  s.setProperty("--ink-3", theme.ink3);

  s.setProperty("--border-subtle", theme.borderSubtle);
  s.setProperty("--border-strong", theme.borderStrong);

  s.setProperty("--accent", accent.color);
  s.setProperty("--accent-ink", accent.ink);
  s.setProperty("--accent-bg", rgba(accent.color, 0.16));
  s.setProperty("--accent-border", rgba(accent.color, 0.3));

  s.setProperty("--success", theme.success);
  s.setProperty("--success-bg", rgba(theme.success, 0.15));
  s.setProperty("--success-border", rgba(theme.success, 0.3));
  s.setProperty("--warning", theme.warning);
  s.setProperty("--warning-bg", rgba(theme.warning, 0.15));
  s.setProperty("--warning-border", rgba(theme.warning, 0.3));
  s.setProperty("--danger", theme.danger);
  s.setProperty("--danger-bg", rgba(theme.danger, 0.15));
  s.setProperty("--danger-border", rgba(theme.danger, 0.3));

  // Non-token consumers (xterm, the native window chrome) read this to decide
  // whether they're on a near-black or a lifted surface.
  document.documentElement.dataset.theme = theme.id;
}

// ── Persistence ─────────────────────────────────────────────────────────────
// Read directly rather than through the store: `main.tsx` applies the theme
// before the store (and React) exist, to avoid a flash of the default palette.

export const LS_THEME = "porta.appearance.theme";
export const LS_ACCENT = "porta.appearance.accent";

export function loadThemeId(): ThemeId {
  if (typeof localStorage === "undefined") return DEFAULT_THEME;
  const v = localStorage.getItem(LS_THEME);
  return THEMES.some((t) => t.id === v) ? (v as ThemeId) : DEFAULT_THEME;
}

export function loadAccentId(): AccentId {
  if (typeof localStorage === "undefined") return DEFAULT_ACCENT;
  const v = localStorage.getItem(LS_ACCENT);
  return ACCENTS.some((a) => a.id === v) ? (v as AccentId) : DEFAULT_ACCENT;
}
