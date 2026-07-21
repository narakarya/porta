// Dumps the porta-git-manager extension's rendered HTML for each fixture input.
// Run manually when the fixture inputs change; the output is committed so the
// test suite never needs the extension repo present.
//
//   node scripts/gen-preview-fixtures.mjs /path/to/porta-git-manager
//
// This script deliberately does no analysis. The parity rule — core must render
// at least as many of each semantic element as the extension did — is evaluated
// in markdown.test.ts using the same countElements() the renderer module
// exports, so there is exactly one implementation of that counting.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const extRoot = process.argv[2];
if (!extRoot) {
  console.error("usage: node scripts/gen-preview-fixtures.mjs <porta-git-manager path>");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const md = require(resolve(extRoot, "md-util.js"));

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../src/lib/preview/fixtures/markdown");

for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  const html = md.render(readFileSync(resolve(dir, file), "utf-8"));
  const name = basename(file, ".md");
  writeFileSync(resolve(dir, `${name}.expected.html`), html + "\n");
  console.log(`${name}: ${html.length} bytes`);
}
