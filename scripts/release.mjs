#!/usr/bin/env node
//
// Porta release driver.
//
//   node scripts/release.mjs <beta|stable> prepare [version] [--dry-run]
//   node scripts/release.mjs <beta|stable> publish  [--dry-run] [--yes]
//
// `prepare` validates the tree, drafts the changelog and bumps the five version
// files, then stops without committing — the working tree is left dirty on
// purpose so polishing the draft is an ordinary edit. `publish` commits what is
// there, pushes, tags, and (for a stable release) fast-forwards main.
//
// Nothing here force-pushes, deletes a ref, or merges non-fast-forward. When a
// guard trips the script explains what is wrong and how to fix it, then exits.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import {
  VERSION_FILES,
  isValidVersion,
  readVersion,
  suggestVersion,
  versionMismatches,
  writeVersion,
} from "./lib/version.mjs";
import {
  consolidateBeta,
  draftFromCommits,
  hasVersion,
  insertSection,
  isBetaVersion,
  topVersion,
} from "./lib/changelog.mjs";

const WORK_BRANCH = "next";
const STABLE_BRANCH = "main";
const CHANGELOG = "CHANGELOG.md";

const MODES = {
  beta: {
    tag: (v) => `beta-v${v}`,
    tagGlob: "beta-v*",
    workflow: "beta-release.yml",
    wantsBetaVersion: true,
  },
  stable: {
    tag: (v) => `v${v}`,
    // `v*` would also match `beta-v*`? No — a glob is anchored, so `v*` cannot
    // match a tag starting with `beta-`. Same rule the two workflows rely on.
    tagGlob: "v*",
    workflow: "release.yml",
    wantsBetaVersion: false,
  },
};

// ─── shell helpers ────────────────────────────────────────────────────────

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

let DRY_RUN = false;

/** Runs a mutating command, or just prints it under --dry-run. */
function run(cmd, args, opts = {}) {
  if (DRY_RUN) {
    console.log(`  [dry-run] ${cmd} ${args.join(" ")}`);
    return "";
  }
  return execFileSync(cmd, args, { encoding: "utf8", stdio: opts.inherit ? "inherit" : "pipe" });
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function fail(message, hint) {
  console.error(`\n${c.red("✗")} ${message}`);
  if (hint) console.error(`  ${c.dim(hint)}`);
  process.exit(1);
}

const step = (message) => console.log(`${c.bold("→")} ${message}`);
const ok = (message) => console.log(`  ${c.green("✓")} ${message}`);
const warn = (message) => console.log(`  ${c.yellow("!")} ${message}`);

async function confirm(question, assumeYes) {
  if (assumeYes || DRY_RUN) return true;
  if (!process.stdin.isTTY) {
    fail("stdin is not a terminal, so the confirmation cannot be answered.", "Re-run with --yes to skip the prompt.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

// ─── guards ───────────────────────────────────────────────────────────────

function requireRepoRoot() {
  let root;
  try {
    root = git("rev-parse", "--show-toplevel");
  } catch {
    fail("not inside a git repository.");
  }
  process.chdir(root);
  return root;
}

function requireWorkBranch() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== WORK_BRANCH) {
    fail(
      `releases are cut from '${WORK_BRANCH}', but HEAD is on '${branch}'.`,
      `git switch ${WORK_BRANCH}`,
    );
  }
}

/** Untracked files are ignored — scratch notes should not block a release. */
function requireCleanTree() {
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty) {
    fail(
      "the working tree has uncommitted changes.",
      "Commit or stash them first — prepare needs a clean base to write into.",
    );
  }
}

function requireInSyncWithOrigin() {
  try {
    run("git", ["fetch", "--quiet", "origin", WORK_BRANCH]);
  } catch {
    warn("could not reach origin; continuing with the local view of the branch.");
    return;
  }
  const behind = git("rev-list", "--count", `HEAD..origin/${WORK_BRANCH}`);
  if (behind !== "0") {
    fail(
      `'${WORK_BRANCH}' is ${behind} commit(s) behind origin.`,
      `git pull --ff-only origin ${WORK_BRANCH}`,
    );
  }
}

function tagExists(tag) {
  try {
    git("rev-parse", "--verify", `refs/tags/${tag}`);
    return true;
  } catch {
    return false;
  }
}

// ─── version selection ────────────────────────────────────────────────────

function lastTag(glob) {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", glob);
  } catch {
    return null;
  }
}

/** Commit subjects since `ref` (or the whole history when there is no tag). */
function subjectsSince(ref) {
  const range = ref ? `${ref}..HEAD` : "HEAD";
  const out = git("log", "--format=%s", range);
  return out ? out.split("\n") : [];
}

async function resolveVersion(mode, explicit, changelogText) {
  const cfg = MODES[mode];
  const collides = (v) => tagExists(cfg.tag(v)) || hasVersion(changelogText, v);

  if (explicit) {
    if (!isValidVersion(explicit)) {
      fail(`'${explicit}' is not a version this repo uses.`, "Expected X.Y.Z or X.Y.Z-beta.N");
    }
    if (cfg.wantsBetaVersion !== isBetaVersion(explicit)) {
      fail(
        `a ${mode} release wants a ${cfg.wantsBetaVersion ? "X.Y.Z-beta.N" : "X.Y.Z"} version, got '${explicit}'.`,
      );
    }
    if (collides(explicit)) {
      fail(
        `version ${explicit} is already taken.`,
        `Tag ${cfg.tag(explicit)} exists, or CHANGELOG.md already has a [${explicit}] section.`,
      );
    }
    return explicit;
  }

  const suggestion = suggestVersion({
    mode,
    current: readVersion(),
    subjects: subjectsSince(lastTag(MODES.beta.tagGlob) ?? lastTag(MODES.stable.tagGlob)),
    collides,
  });

  console.log(`  current: ${readVersion()}   suggested ${mode}: ${c.bold(suggestion)}`);
  if (DRY_RUN || !process.stdin.isTTY) return suggestion;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  Use ${suggestion}? Enter to accept, or type another version: `)).trim();
  rl.close();

  if (!answer) return suggestion;
  return resolveVersion(mode, answer, changelogText);
}

// ─── phases ───────────────────────────────────────────────────────────────

function runChecks() {
  step("Running the validation chain");
  try {
    execFileSync("node_modules/.bin/tsc", ["--noEmit"], { stdio: "inherit" });
    ok("tsc --noEmit");
  } catch {
    fail("TypeScript check failed.", "Fix the errors above, then re-run.");
  }
  try {
    execFileSync("cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml"], { stdio: "inherit" });
    ok("cargo check");
  } catch {
    fail("cargo check failed.", "Fix the errors above, then re-run.");
  }
}

async function prepare(mode, explicitVersion) {
  const cfg = MODES[mode];

  step("Checking the working tree");
  requireWorkBranch();
  requireCleanTree();
  requireInSyncWithOrigin();
  ok(`on ${WORK_BRANCH}, clean, in sync with origin`);

  step("Choosing a version");
  const changelogText = readFileSync(CHANGELOG, "utf8");
  const version = await resolveVersion(mode, explicitVersion, changelogText);
  const tag = cfg.tag(version);
  ok(`${version} (tag ${tag})`);

  runChecks();

  step("Drafting the changelog entry");
  const date = new Date().toISOString().slice(0, 10);
  let nextChangelog;

  if (mode === "stable") {
    const result = consolidateBeta(changelogText, version, date);
    nextChangelog = result.text;
    ok(`folded ${result.consumed.length} beta section(s): ${result.consumed.join(", ")}`);
    for (const w of result.warnings) warn(w);
  } else {
    const since = lastTag(cfg.tagGlob);
    const categories = draftFromCommits(subjectsSince(since));
    const count = [...categories.values()].reduce((n, list) => n + list.length, 0);
    if (count === 0) {
      fail(
        `no commits since ${since ?? "the start of history"} to describe.`,
        "There is nothing to release.",
      );
    }
    nextChangelog = insertSection(changelogText, version, null, categories);
    ok(`drafted ${count} entr(ies) from commits since ${since ?? "the start of history"}`);
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] would write ${CHANGELOG}`);
  } else {
    writeFileSync(CHANGELOG, nextChangelog);
  }

  step("Bumping the version files");
  const changed = writeVersion(version, { dryRun: DRY_RUN });
  if (changed.length === 0) {
    ok(`already at ${version}`);
  } else {
    for (const file of changed) ok(file);
  }
  const missed = VERSION_FILES.filter((f) => !changed.includes(f));
  if (missed.length && changed.length) console.log(`  ${c.dim(`unchanged: ${missed.join(", ")}`)}`);

  console.log(`
${c.bold("Prepared")} ${version}. Nothing has been committed.

  1. Polish the draft at the top of ${CHANGELOG}
  2. ${c.bold(`node scripts/release.mjs ${mode} publish`)}
`);
}

async function publish(mode, { assumeYes }) {
  const cfg = MODES[mode];

  step("Checking the working tree");
  requireWorkBranch();
  requireInSyncWithOrigin();

  const version = readVersion();
  const tag = cfg.tag(version);

  const mismatches = versionMismatches(version);
  if (mismatches.length) {
    fail(
      `the version files disagree with package.json (${version}):\n    ${mismatches.join("\n    ")}`,
      `Re-run: node scripts/release.mjs ${mode} prepare ${version}`,
    );
  }

  const top = topVersion(readFileSync(CHANGELOG, "utf8"));
  if (top !== version) {
    fail(
      `CHANGELOG.md's newest section is [${top}], but the version files say ${version}.`,
      "The release section must be the topmost one.",
    );
  }
  if (cfg.wantsBetaVersion !== isBetaVersion(version)) {
    fail(`${version} is not a ${mode} version — did you mean the other mode?`);
  }
  if (tagExists(tag)) {
    fail(`tag ${tag} already exists.`, "This release has already been cut.");
  }
  ok(`${version} is consistent across ${CHANGELOG} and all five version files`);

  runChecks();

  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty) {
    console.log(`\n${c.dim(dirty)}\n`);
    if (!(await confirm(`Commit these as "chore(release): v${version}"?`, assumeYes))) {
      fail("aborted before committing.");
    }
    step("Committing");
    // Stage tracked changes only — untracked scratch files stay out.
    run("git", ["commit", "--all", "--message", `chore(release): v${version}`]);
    ok(`chore(release): v${version}`);
  } else {
    ok("nothing to commit; releasing the current HEAD");
  }

  step(`Pushing ${WORK_BRANCH}`);
  // Full refs throughout: the `beta` release tag makes a bare branch name
  // ambiguous, and an ambiguous refspec is a push failure mid-release.
  run("git", ["push", "origin", `refs/heads/${WORK_BRANCH}`]);
  ok(`origin/${WORK_BRANCH}`);

  if (mode === "stable") {
    step(`Fast-forwarding ${STABLE_BRANCH}`);
    run("git", ["switch", STABLE_BRANCH]);
    try {
      run("git", ["merge", "--ff-only", WORK_BRANCH]);
    } catch {
      run("git", ["switch", WORK_BRANCH]);
      fail(
        `${STABLE_BRANCH} cannot fast-forward to ${WORK_BRANCH}.`,
        `${STABLE_BRANCH} has commits of its own. Reconcile the two branches by hand, then re-run publish.`,
      );
    }
    run("git", ["push", "origin", `refs/heads/${STABLE_BRANCH}`]);
    run("git", ["switch", WORK_BRANCH]);
    ok(`origin/${STABLE_BRANCH}`);
  }

  step(`Tagging ${tag}`);
  run("git", ["tag", tag]);
  run("git", ["push", "origin", `refs/tags/${tag}`]);
  ok(`pushed ${tag} — ${cfg.workflow} will pick it up`);

  watchWorkflow(cfg.workflow);
}

/** Best-effort CI follow-along; a missing `gh` must not fail a done release. */
function watchWorkflow(workflow) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would watch ${workflow}`);
    return;
  }
  step("Watching the release workflow");
  try {
    // The run does not exist the instant the tag lands; give GitHub a moment.
    execFileSync("sleep", ["10"]);
    const id = execFileSync(
      "gh",
      ["run", "list", "--workflow", workflow, "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"],
      { encoding: "utf8" },
    ).trim();
    if (!id) throw new Error("no run found");
    execFileSync("gh", ["run", "watch", id, "--exit-status"], { stdio: "inherit" });
    ok("workflow finished");
  } catch {
    warn(`could not follow the run; check it with: gh run list --workflow=${workflow}`);
  }
}

// ─── entry point ──────────────────────────────────────────────────────────

const USAGE = `Usage:
  node scripts/release.mjs <beta|stable> prepare [version] [--dry-run]
  node scripts/release.mjs <beta|stable> publish [--yes] [--dry-run]`;

async function main() {
  const argv = process.argv.slice(2);
  DRY_RUN = argv.includes("--dry-run");
  const assumeYes = argv.includes("--yes");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [mode, phase, version] = positional;

  if (!MODES[mode] || !["prepare", "publish"].includes(phase)) {
    console.error(USAGE);
    process.exit(1);
  }

  requireRepoRoot();
  console.log(c.bold(`\nPorta ${mode} release — ${phase}${DRY_RUN ? " (dry run)" : ""}\n`));

  if (phase === "prepare") await prepare(mode, version);
  else await publish(mode, { assumeYes });
}

main().catch((err) => fail(err.message));
