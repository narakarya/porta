import { describe, it, expect } from "vitest";
import { detectLogRemedy } from "./log-remedies";

describe("detectLogRemedy", () => {
  it("returns null for ordinary output", () => {
    expect(detectLogRemedy(["[info] Running Endpoint at http://localhost:4000"])).toBeNull();
  });

  it("offers mix deps.get for unchecked dependencies", () => {
    const out = detectLogRemedy([
      "** (Mix) Unchecked dependencies for environment dev:",
      "* phoenix (Hex package)",
    ]);
    expect(out?.command).toBe("mix deps.get");
  });

  it("offers mise trust for an untrusted config", () => {
    // Verbatim from a fresh worktree instance of a mise-managed Phoenix repo.
    // mise spreads the message over three lines and pluralises ("files … are
    // not trusted"), and the failure the user actually sees is the mix line
    // several lines later — so the scan has to reach back past it.
    const out = detectLogRemedy([
      "mise ERROR error parsing config file: ~/projects/app/app-worktrees/feat-x/.mise.toml",
      "mise ERROR Config files in ~/projects/app/app-worktrees/feat-x/.mise.toml are not trusted.",
      "Trust them with `mise trust`. See https://mise.en.dev/cli/trust.html for more information.",
      "mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information",
      "zsh: command not found: mix",
    ]);
    expect(out?.command).toBe("mise trust");
  });

  it("does not mistake a missing mix for a missing node_modules", () => {
    // `command not found: mix` is the symptom of the mise failure above, not a
    // JS dependency problem — suggesting `npm install` here would be worse
    // than suggesting nothing.
    expect(detectLogRemedy(["zsh: command not found: mix"])).toBeNull();
  });

  it("picks the package manager out of the start command", () => {
    const lines = ["Error: Cannot find module 'vite'"];
    expect(detectLogRemedy(lines, { startCommand: "pnpm dev" })?.command).toBe("pnpm install");
    expect(detectLogRemedy(lines, { startCommand: "npm run dev" })?.command).toBe("npm install");
    expect(detectLogRemedy(lines)?.command).toBe("npm install");
  });

  it("reports the newest failure, not the first", () => {
    const out = detectLogRemedy([
      "** (Mix) Unchecked dependencies for environment dev:",
      "[info] deps fetched",
      'Run "mix ecto.migrate" to run pending migrations',
    ]);
    expect(out?.command).toBe("mix ecto.migrate");
  });

  it("ignores anything older than the tail window", () => {
    const noise = new Array(50).fill("[info] tick");
    expect(detectLogRemedy(["mise ERROR run `mise trust`", ...noise], {}, 10)).toBeNull();
  });
});
