// Reads and writes the five files that carry Porta's version number.
//
// Each file is edited surgically rather than rewritten, because a blanket
// search-and-replace is wrong for two of them: `package-lock.json` mentions
// dependency versions that can coincide with ours, and `Cargo.lock` holds one
// `[[package]]` block per crate — `group 0.13.0` sat right next to
// `porta 0.13.0` at the last release.

import { readFileSync, writeFileSync } from "node:fs";

/** Human-readable list of the files a bump touches, for logs and errors. */
export const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

const SEMVER = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;

export function isValidVersion(v) {
  return SEMVER.test(v);
}

/** Splits `1.2.3-beta.4` into its parts; `beta` is null on a stable version. */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(v);
  if (!m) throw new Error(`unparseable version: ${v}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    beta: m[4] === undefined ? null : Number(m[4]),
    base: `${m[1]}.${m[2]}.${m[3]}`,
  };
}

export function bumpMinor(base) {
  const { major, minor } = parseVersion(base);
  return `${major}.${minor + 1}.0`;
}

export function bumpPatch(base) {
  const { major, minor, patch } = parseVersion(base);
  return `${major}.${minor}.${patch + 1}`;
}

/** The version currently declared in package.json — the source of truth. */
export function readVersion() {
  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

/**
 * Reads the version each file declares, so a caller can prove all five agree
 * before tagging. Returns a `{ file: version }` map.
 */
export function readAllVersions() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf8");
  const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf8");

  return {
    "package.json": pkg.version,
    "package-lock.json": lock.version,
    'package-lock.json (packages[""])': lock.packages?.[""]?.version,
    "src-tauri/tauri.conf.json": conf.version,
    "src-tauri/Cargo.toml": /^version = "([^"]*)"/m.exec(cargoToml)?.[1],
    "src-tauri/Cargo.lock": PORTA_LOCK_ENTRY.exec(cargoLock)?.[2],
  };
}

/** Files whose declared version differs from `expected`. */
export function versionMismatches(expected) {
  return Object.entries(readAllVersions())
    .filter(([, v]) => v !== expected)
    .map(([file, v]) => `${file}: ${v ?? "(not found)"}`);
}

// The `porta` crate's own entry in Cargo.lock. Capturing the surrounding block
// keeps the substitution from landing on another crate that shares our version.
const PORTA_LOCK_ENTRY = /(\[\[package\]\]\nname = "porta"\nversion = ")([^"]*)(")/;

/** Writes `version` into all five files. Returns the paths actually changed. */
export function writeVersion(version, { dryRun = false } = {}) {
  const changed = [];

  const editJson = (path, mutate) => {
    const before = readFileSync(path, "utf8");
    const json = JSON.parse(before);
    mutate(json);
    const after = JSON.stringify(json, null, 2) + "\n";
    if (after !== before) {
      if (!dryRun) writeFileSync(path, after);
      changed.push(path);
    }
  };

  const editText = (path, pattern, replacement) => {
    const before = readFileSync(path, "utf8");
    if (!pattern.test(before)) {
      throw new Error(`could not locate the version field in ${path}`);
    }
    const after = before.replace(pattern, replacement);
    if (after !== before) {
      if (!dryRun) writeFileSync(path, after);
      changed.push(path);
    }
  };

  editJson("package.json", (j) => {
    j.version = version;
  });
  editJson("package-lock.json", (j) => {
    j.version = version;
    if (j.packages?.[""]) j.packages[""].version = version;
  });
  editJson("src-tauri/tauri.conf.json", (j) => {
    j.version = version;
  });
  editText("src-tauri/Cargo.toml", /^version = "[^"]*"/m, `version = "${version}"`);
  editText("src-tauri/Cargo.lock", PORTA_LOCK_ENTRY, `$1${version}$3`);

  return changed;
}

/**
 * Suggests the next version.
 *
 * Stable: drop any `-beta.N` suffix. Beta: continue the current beta line, or
 * open a new one sized by the commits since the last release — a `feat:` in the
 * batch makes it a MINOR, anything else a PATCH. The caller still decides; this
 * only saves typing, and `collides` pushes the suggestion past any number the
 * changelog or the tag list has already claimed.
 */
export function suggestVersion({ mode, current, subjects, collides }) {
  const cur = parseVersion(current);

  if (mode === "stable") {
    let base = cur.base;
    while (collides(base)) base = bumpMinor(base);
    return base;
  }

  if (cur.beta !== null) {
    let n = cur.beta + 1;
    while (collides(`${cur.base}-beta.${n}`)) n += 1;
    return `${cur.base}-beta.${n}`;
  }

  const featured = subjects.some((s) => /^feat(\(|!|:)/.test(s));
  let base = featured ? bumpMinor(cur.base) : bumpPatch(cur.base);
  while (collides(`${base}-beta.1`)) base = bumpMinor(base);
  return `${base}-beta.1`;
}
