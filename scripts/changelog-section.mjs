#!/usr/bin/env node
//
//   node scripts/changelog-section.mjs <version> [changelog-path]
//
// Prints one version's CHANGELOG section to stdout. The release workflows use
// it to fill `latest.json`'s `notes`, so the update toast shows the notes that
// were actually written for the release instead of a heap of commit subjects.
//
// Exits 1 with nothing on stdout when the section is missing or empty, which is
// the signal for the workflow to fall back to its commit log.

import { readFileSync } from "node:fs";
import { sectionFor } from "./lib/changelog.mjs";

const [version, path = "CHANGELOG.md"] = process.argv.slice(2);

if (!version) {
  console.error("usage: changelog-section.mjs <version> [changelog-path]");
  process.exit(2);
}

let text;
try {
  text = readFileSync(path, "utf8");
} catch (e) {
  console.error(`cannot read ${path}: ${e.message}`);
  process.exit(1);
}

const body = sectionFor(text, version);
if (body === null) {
  console.error(`no CHANGELOG section for ${version}`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
