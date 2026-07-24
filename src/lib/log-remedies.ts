// Known "this run died because a setup step is missing" failures, matched
// against the tail of an app's output. Every one of these is a boot failure the
// user can only fix by reading the log, remembering the incantation and typing
// it in a terminal — so Porta reads the log and offers the command instead.
//
// Adding a rule: keep the pattern anchored on text the tool actually prints
// (not a paraphrase), and only suggest a command that is safe to re-run.

export interface LogRemedy {
  id: string;
  /** What went wrong, in the user's terms. */
  title: string;
  /** The shell command to run in the app's root dir. Must be idempotent. */
  command: string;
}

interface Ctx {
  /** The app's start command — used to guess the JS package manager. */
  startCommand?: string | null;
}

/** npm / pnpm / yarn / bun, guessed from the start command (default npm). */
function jsInstall(ctx: Ctx, line: string): string {
  const hay = `${ctx.startCommand ?? ""} ${line}`;
  if (/\bpnpm\b/.test(hay)) return "pnpm install";
  if (/\byarn\b/.test(hay)) return "yarn install";
  if (/\bbun\b/.test(hay)) return "bun install";
  return "npm install";
}

type Rule = {
  id: string;
  test: RegExp;
  title: string;
  command: string | ((ctx: Ctx, line: string) => string);
};

const RULES: Rule[] = [
  {
    // mise refuses to load an untrusted config, so every tool version the app
    // needs silently disappears and the start command fails on PATH — the
    // visible symptom is a `command not found: mix` several lines later.
    //
    // Matched against what mise actually prints, which spans three lines and
    // pluralises: "Config files in <path> are not trusted." then "Trust them
    // with `mise trust`." Each alternative below matches one of those lines on
    // its own, because the scan is line-by-line.
    //
    // A fresh worktree is a fresh path, so every new branch instance of a
    // mise-managed repo hits this on first run.
    id: "mise-trust",
    test: /\bmise trust\b|mise\b.*not trusted|not trusted.*\.mise\.toml/i,
    title: "mise won't load this project's config until it's trusted",
    command: "mise trust",
  },
  {
    id: "hex-missing",
    test: /could not find hex|hex is not available|install hex\?/i,
    title: "Hex isn't installed for this Elixir version",
    command: "mix local.hex --force",
  },
  {
    id: "mix-deps-get",
    test: /unchecked dependencies for environment|run "mix deps\.get"|mix deps\.get.*to install|dependency .* is not available/i,
    title: "Dependencies aren't fetched",
    command: "mix deps.get",
  },
  {
    id: "mix-deps-compile",
    test: /could not compile dependency|run "mix deps\.compile"/i,
    title: "A dependency needs recompiling",
    command: "mix deps.compile",
  },
  {
    id: "ecto-create",
    test: /database .* does not exist|run "mix ecto\.create"/i,
    title: "The database hasn't been created",
    command: "mix ecto.create",
  },
  {
    id: "ecto-migrate",
    test: /run "mix ecto\.migrate"|migrations? are pending|relation "[a-z_]+" does not exist/i,
    title: "Migrations are pending",
    command: "mix ecto.migrate",
  },
  {
    id: "bundle-install",
    test: /run `bundle install`|could not find .* in (?:locally installed gems|any of the sources)|bundler: command not found/i,
    title: "Gems aren't installed",
    command: "bundle install",
  },
  {
    id: "js-install",
    test: /cannot find module|err_module_not_found|command not found: (?:vite|next|nuxt|astro|tsx|ts-node)|sh: (?:vite|next|nuxt|astro): command not found/i,
    title: "Node modules are missing",
    command: jsInstall,
  },
];

/**
 * The most recent actionable failure in `lines`, or null. Scans newest-first so
 * a fixed-then-refailed run offers the *current* problem, and only looks at the
 * tail — an install error from an hour ago isn't why this boot died.
 */
export function detectLogRemedy(lines: string[], ctx: Ctx = {}, tail = 200): LogRemedy | null {
  const start = Math.max(0, lines.length - tail);
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i];
    if (!line) continue;
    for (const rule of RULES) {
      if (!rule.test.test(line)) continue;
      return {
        id: rule.id,
        title: rule.title,
        command: typeof rule.command === "function" ? rule.command(ctx, line) : rule.command,
      };
    }
  }
  return null;
}
