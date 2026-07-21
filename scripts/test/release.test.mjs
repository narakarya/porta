// Tests for the release helpers. Run with: node --test scripts/test/
//
// The orchestration in release.mjs is git plumbing and is exercised by
// `--dry-run`; what is worth pinning down here is the text munging, where the
// edge cases live: which sections get folded, which bullets survive a move, and
// which `version = "…"` line in a lock file is ours.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  consolidateBeta,
  draftFromCommits,
  hasVersion,
  insertSection,
  splitCategories,
  topVersion,
} from "../lib/changelog.mjs";
import { suggestVersion, versionMismatches, writeVersion } from "../lib/version.mjs";

const PREAMBLE = `# Changelog

All notable changes are documented in this file.

`;

const SAMPLE = `${PREAMBLE}## [0.12.0-beta.2]

Backports a round of feedback. Beta channel.

### Fixed

- Logs regained the line-number gutter and the six level badges, which the
  rewrite had dropped.

### Changed

- One update popover instead of two.

## [0.12.0-beta.1]

### Added

- Git tab.

### Fixed

- Open button no longer a no-op.

## [0.11.0] — 2026-07-19

### Fixed

- Something already released.
`;

test("consolidateBeta folds the leading beta run into one section", () => {
  const { text, consumed, warnings } = consolidateBeta(SAMPLE, "0.13.0", "2026-07-21");

  assert.deepEqual(consumed, ["0.12.0-beta.2", "0.12.0-beta.1"]);
  assert.equal(topVersion(text), "0.13.0");
  assert.ok(hasVersion(text, "0.11.0"), "the released section below the run survives");
  assert.ok(!hasVersion(text, "0.12.0-beta.1"), "folded sections are removed");

  // Categories merge across sections and keep the canonical order.
  const order = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 3), ["Added", "Changed", "Fixed"]);

  assert.ok(text.includes("- Git tab."));
  assert.ok(text.includes("- One update popover instead of two."));
  assert.ok(
    text.includes("  rewrite had dropped."),
    "a wrapped bullet keeps its continuation line",
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /0\.12\.0-beta\.2/);
  assert.match(warnings[0], /Backports a round of feedback/);
});

test("consolidateBeta refuses when the top section is already released", () => {
  const released = `${PREAMBLE}## [0.11.0] — 2026-07-19\n\n### Fixed\n\n- Something.\n`;
  assert.throws(() => consolidateBeta(released, "0.12.0", "2026-07-21"), /no beta sections/);
});

test("splitCategories separates bullets from lead prose", () => {
  const { categories, prose } = splitCategories(
    "\nA lead paragraph.\n\n### Added\n\n- One\n  continued\n\n- Two\n",
  );
  assert.deepEqual(prose, ["A lead paragraph."]);
  assert.deepEqual(categories.get("Added"), ["- One\n  continued", "- Two"]);
});

test("draftFromCommits maps conventional types and drops release noise", () => {
  const categories = draftFromCommits([
    "feat(git): word-level diff highlighting",
    "fix: reset diff state on file switch",
    "chore(release): v0.12.0-beta.5 — updater quiet-fail",
    "merge: beta.8 release line",
    "something unconventional",
  ]);

  assert.deepEqual(categories.get("Added"), ["- **git**: Word-level diff highlighting"]);
  assert.deepEqual(categories.get("Fixed"), ["- Reset diff state on file switch"]);
  assert.deepEqual(categories.get("Changed"), ["- Something unconventional"]);
});

test("insertSection puts the draft above every existing section", () => {
  const text = insertSection(SAMPLE, "0.12.0-beta.3", null, draftFromCommits(["fix: a thing"]));
  assert.equal(topVersion(text), "0.12.0-beta.3");
  assert.ok(hasVersion(text, "0.12.0-beta.2"));
});

test("suggestVersion drops the beta suffix, then steps past a taken number", () => {
  const free = () => false;
  assert.equal(suggestVersion({ mode: "stable", current: "0.12.0-beta.11", subjects: [], collides: free }), "0.12.0");

  // 0.12.0 already claimed by an untagged changelog section — the real case
  // that forced 0.13.0 at the last release.
  const taken = (v) => v === "0.12.0";
  assert.equal(suggestVersion({ mode: "stable", current: "0.12.0-beta.11", subjects: [], collides: taken }), "0.13.0");
});

test("suggestVersion continues a beta line, or opens one sized by the commits", () => {
  const free = () => false;
  assert.equal(suggestVersion({ mode: "beta", current: "0.12.0-beta.5", subjects: [], collides: free }), "0.12.0-beta.6");
  assert.equal(
    suggestVersion({ mode: "beta", current: "0.13.0", subjects: ["fix: a thing"], collides: free }),
    "0.13.1-beta.1",
  );
  assert.equal(
    suggestVersion({ mode: "beta", current: "0.13.0", subjects: ["feat(git): a thing"], collides: free }),
    "0.14.0-beta.1",
  );
});

// ─── version files ────────────────────────────────────────────────────────

const cwd = process.cwd();
after(() => process.chdir(cwd));

test("writeVersion touches our crate in Cargo.lock and leaves namesakes alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "porta-release-"));
  mkdirSync(join(dir, "src-tauri"));
  const write = (p, s) => writeFileSync(join(dir, p), s);

  write("package.json", JSON.stringify({ name: "porta", version: "0.13.0" }, null, 2) + "\n");
  write(
    "package-lock.json",
    JSON.stringify({ name: "porta", version: "0.13.0", packages: { "": { version: "0.13.0" } } }, null, 2) + "\n",
  );
  write("src-tauri/tauri.conf.json", JSON.stringify({ version: "0.13.0" }, null, 2) + "\n");
  write("src-tauri/Cargo.toml", '[package]\nname = "porta"\nversion = "0.13.0"\nedition = "2021"\n');
  write(
    "src-tauri/Cargo.lock",
    '[[package]]\nname = "group"\nversion = "0.13.0"\n\n[[package]]\nname = "porta"\nversion = "0.13.0"\ndependencies = []\n',
  );

  process.chdir(dir);
  const changed = writeVersion("0.14.0-beta.1");
  assert.equal(changed.length, 5);
  assert.deepEqual(versionMismatches("0.14.0-beta.1"), []);

  const lock = readFileSync(join(dir, "src-tauri/Cargo.lock"), "utf8");
  assert.ok(lock.includes('name = "group"\nversion = "0.13.0"'), "the unrelated crate keeps its version");
  assert.ok(lock.includes('name = "porta"\nversion = "0.14.0-beta.1"'));

  process.chdir(cwd);
});
