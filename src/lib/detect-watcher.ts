// Heuristic watcher detection from an app's start command. Used to show a
// small badge so devs know whether their stack already handles reload.
//
// `hmr`    — in-process hot reload, no restart (Next dev, Vite, Phoenix code_reloader, etc.)
// `native` — external watcher restarts the process (cargo watch, air, nodemon, bun --hot)
// `none`   — no auto-reload detected; saving a file does nothing on its own.

export type WatcherType = "hmr" | "native" | "none";

const HMR_PATTERNS = [
  /\b(next|nuxt|astro|remix|sveltekit|vite|wrangler)\s+dev\b/,
  /\bvue-cli-service\s+serve\b/,
  /\bng\s+serve\b/,
  /\bphx\.server\b/,        // Phoenix code_reloader
  /\bbin\/dev\b/,            // Rails 7+ foreman-based dev script (esbuild + jsbundling watch)
  /\b(npm|yarn|pnpm|bun)\s+(run\s+)?dev\b/, // assume `dev` script wires up HMR
];

const NATIVE_PATTERNS = [
  /\bcargo\s+watch\b/,
  /\bair\b/,                 // cosmtrek/air for Go
  /\bnodemon\b/,
  /\bbun\s+(--hot|run\s+--hot)\b/,
  /\bgowatch\b/,
  /\bwatchexec\b/,
  /\breflex\b/,              // cespare/reflex
  /\bmodd\b/,
];

export function detectWatcher(startCommand: string | null | undefined): WatcherType {
  if (!startCommand) return "none";
  const cmd = startCommand.toLowerCase();
  for (const re of HMR_PATTERNS) if (re.test(cmd)) return "hmr";
  for (const re of NATIVE_PATTERNS) if (re.test(cmd)) return "native";
  return "none";
}
