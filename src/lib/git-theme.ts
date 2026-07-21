/**
 * Git tab palettes. Ported from porta-git-manager, which shipped seven themes.
 * The tab owns its full chrome by design, so `paper` is a light palette that
 * will contrast with Porta's dark chrome — that is intended, not a bug.
 *
 * Palette values live in src/styles/git-theme.css; this module is the registry
 * and the type guard.
 */
export type GitTheme =
  | "dark"
  | "graphite"
  | "soft-dark"
  | "midnight"
  | "paper"
  | "forest"
  | "sunset";

export const GIT_THEMES: { id: GitTheme; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "graphite", label: "Graphite" },
  { id: "soft-dark", label: "Soft Dark" },
  { id: "midnight", label: "Midnight" },
  { id: "paper", label: "Paper" },
  { id: "forest", label: "Forest" },
  { id: "sunset", label: "Sunset" },
];

const IDS = new Set<string>(GIT_THEMES.map((t) => t.id));

export function isGitTheme(v: unknown): v is GitTheme {
  return typeof v === "string" && IDS.has(v);
}

export const DEFAULT_GIT_THEME: GitTheme = "dark";
