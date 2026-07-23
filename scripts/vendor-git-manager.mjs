#!/usr/bin/env node
// Vendors the porta-git-manager extension into src/vendor/git-manager/ so it can
// run in-process inside Porta's window instead of inside an extension iframe.
//
// The extension is vanilla JS with a very narrow host seam, so "vendoring" is a
// copy plus a short list of mechanical patches — no rewrite. Every patch below
// asserts how many sites it expects to hit and throws when the count is wrong,
// so an upstream change that invalidates a patch fails here loudly instead of
// producing a subtly broken tab.
//
// Re-sync with:  npm run vendor:git-manager
// Source repo:   ../porta-git-manager (override with GIT_MANAGER_SRC)

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const SRC = process.env.GIT_MANAGER_SRC
  ? resolve(process.env.GIT_MANAGER_SRC)
  : resolve(REPO, "..", "porta-git-manager");
const OUT = join(REPO, "src", "vendor", "git-manager");

/** Script load order, taken from the extension's index.html. */
const SCRIPTS = [
  "text-util.js",
  "diff-util.js",
  "highlight.js",
  "md-util.js",
  "file-tree.js",
  "status-util.js",
  "git-util.js",
  "dom-util.js",
  "app.js",
];

/**
 * Patches applied to app.js. `count` is the exact number of replacements
 * expected — a mismatch means upstream moved and the patch needs review.
 *
 * The theme of every patch is the same: the extension assumed it owned a whole
 * document, and in-process it owns one <div> instead. `GM_ROOT()` resolves to
 * that div.
 */
const APP_PATCHES = [
  // Boot: no DOMContentLoaded to wait for — the host calls init() after it has
  // injected the markup and installed the bridge.
  {
    why: "hand init() to the host instead of self-starting",
    find: `document.addEventListener("DOMContentLoaded", init);`,
    replace: `window.__GM_INIT = init;`,
    count: 1,
  },
  // Queries: scope every lookup to the mounted root so ids/classes can't
  // collide with Porta's own DOM.
  {
    why: "scope querySelectorAll to the mount root",
    find: `document.querySelectorAll(`,
    replace: `GM_ROOT().querySelectorAll(`,
    count: 5,
  },
  {
    why: "scope getElementById to the mount root",
    re: /document\.getElementById\(([^)]*)\)/g,
    replace: `GM_ROOT().querySelector("#" + $1)`,
    count: 2,
  },
  {
    why: "scope querySelector to the mount root",
    find: `document.querySelector(`,
    replace: `GM_ROOT().querySelector(`,
    count: 11,
  },
  // Theme: the extension writes its palette onto <html>. In-process that would
  // repaint all of Porta, so it goes on the mount root instead — which is also
  // what makes the stylesheet's `.gm-root` variable block resolve.
  {
    why: "keep the theme attribute off Porta's <html>",
    find: `document.documentElement`,
    replace: `GM_ROOT()`,
    count: 2,
  },
  // Overlays (context menu, hidden copy input) were appended to <body>, which
  // in-process puts them outside the scoped stylesheet.
  {
    why: "keep overlays inside the styled subtree",
    find: `document.body`,
    replace: `GM_ROOT()`,
    count: 3,
  },
  // Global listeners: rebinding to the root means the extension's keyboard
  // shortcuts only fire while focus is actually inside the Git tab, instead of
  // firing anywhere in Porta.
  {
    why: "scope document-level listeners to the mount root",
    find: `document.addEventListener(`,
    replace: `GM_ROOT().addEventListener(`,
    count: 2,
  },
  {
    why: "scope window keydown/pointerdown listeners to the mount root",
    find: `window.addEventListener(`,
    replace: `GM_ROOT().addEventListener(`,
    count: 7,
  },
  {
    why: "match the rebound removeEventListener calls",
    find: `window.removeEventListener(`,
    replace: `GM_ROOT().removeEventListener(`,
    count: 5,
  },
];

/** Bundled with the extension; copied into public/ so the vendored @font-face
 *  rules resolve at runtime. */
const FONTS = [
  "JetBrainsMono-Regular.woff2",
  "JetBrainsMono-Medium.woff2",
  "JetBrainsMono-SemiBold.woff2",
  "JetBrainsMono-Bold.woff2",
];

/**
 * Patches applied to the *scoped* part of style.css — the page-level selectors
 * that have no meaning once the stylesheet describes one <div> instead of a
 * document.
 */
const CSS_PATCHES = [
  { why: "variables move from :root onto the mount root", find: `:root`, replace: `:scope` },
  { why: "page-level rules apply to the mount root", find: `html, body {`, replace: `:scope {`, count: 1 },
  { why: "don't reset box-sizing for all of Porta", find: `* { box-sizing: border-box; }`, replace: `:scope, :scope * { box-sizing: border-box; }`, count: 1 },
];

/**
 * Splits top-level `@font-face` / `@keyframes` blocks out of the stylesheet.
 *
 * Everything else gets wrapped in `@scope (.gm-root)`, which is what stops the
 * extension's 424 class names from painting Porta's own DOM — `tab`, `running`,
 * `spinner`, `sep`, `spinning` and `md-body` are all names both sides use.
 * These two at-rules stay outside the wrapper because font families and
 * animation names are global identifiers, not selectors, and nesting them buys
 * nothing while risking a parse failure.
 */
function splitGlobalAtRules(css) {
  const globals = [];
  const rest = [];
  let i = 0;
  while (i < css.length) {
    const isGlobal = /^\s*@(font-face|keyframes)\b/.test(css.slice(i, i + 40));
    if (!isGlobal) {
      const next = css.indexOf("@", i + 1);
      const stop = next === -1 ? css.length : next;
      rest.push(css.slice(i, stop));
      i = stop;
      continue;
    }
    const open = css.indexOf("{", i);
    if (open === -1) { rest.push(css.slice(i)); break; }
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) { j++; break; }
    }
    globals.push(css.slice(i, j));
    i = j;
  }
  if (globals.length !== 8) {
    throw new Error(`style.css: expected 8 global at-rule blocks (4 @font-face + 4 @keyframes), found ${globals.length}`);
  }
  return { globals: globals.join("\n"), rest: rest.join("") };
}

function applyPatches(source, patches, label) {
  let out = source;
  for (const p of patches) {
    let hits = 0;
    if (p.re) {
      out = out.replace(p.re, (...args) => {
        hits++;
        return p.replace.replace(/\$1/g, args[1]);
      });
    } else {
      const parts = out.split(p.find);
      hits = parts.length - 1;
      out = parts.join(p.replace);
    }
    if (p.count !== undefined && hits !== p.count) {
      throw new Error(
        `${label}: patch "${p.why}" expected ${p.count} site(s) but hit ${hits}.\n` +
          `Upstream porta-git-manager changed — review the patch before re-vendoring.`,
      );
    }
    if (hits === 0) throw new Error(`${label}: patch "${p.why}" matched nothing.`);
  }
  return out;
}

/** Pull the <body> contents out of index.html — that's the tab's markup. */
function extractMarkup(html) {
  const open = html.match(/<body[^>]*>/i);
  const close = html.lastIndexOf("</body>");
  if (!open || close === -1) throw new Error("index.html: could not find <body>…</body>");
  return html.slice(open.index + open[0].length, close).trim();
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const banner = (name) =>
  `// VENDORED from porta-git-manager/${name} — do not edit by hand.\n` +
  `// Re-sync with: npm run vendor:git-manager (see scripts/vendor-git-manager.mjs)\n`;

for (const name of SCRIPTS) {
  const raw = readFileSync(join(SRC, name), "utf8");
  let body = raw;
  if (name === "app.js") {
    body = applyPatches(raw, APP_PATCHES, name);
    // GM_ROOT is referenced by the patches above; define it inside the IIFE so
    // it can't leak into Porta's globals.
    body = body.replace(
      `  const bridge = window.portaBridge;`,
      `  const GM_ROOT = () => window.__GM_ROOT || document;\n  const bridge = window.portaBridge;`,
    );
    if (!body.includes("const GM_ROOT")) throw new Error("app.js: could not install the GM_ROOT helper");
  }
  writeFileSync(join(OUT, name), banner(name) + body);
  // A sibling .d.ts is what lets `import "./app.js"` typecheck without turning
  // on allowJs for 5k lines of vendored vanilla JS. They export nothing — every
  // file communicates through `window.GM*` globals.
  writeFileSync(join(OUT, name.replace(/\.js$/, ".d.ts")), `${banner(name)}export {};\n`);
}

// The extension bundles JetBrains Mono. Porta's own font stack asks for the same
// family by name without shipping it, so leaving the family name alone would
// silently restyle every mono surface in Porta the moment this tab is opened.
// Renaming keeps the spike's blast radius inside the Git tab.
mkdirSync(join(REPO, "public", "fonts"), { recursive: true });
for (const font of FONTS) {
  writeFileSync(join(REPO, "public", "fonts", font), readFileSync(join(SRC, "fonts", font)));
}

const { globals, rest } = splitGlobalAtRules(
  readFileSync(join(SRC, "style.css"), "utf8")
    .replaceAll(`"JetBrains Mono"`, `"GM JetBrains Mono"`)
    .replaceAll(`url("fonts/`, `url("/fonts/`),
);
const scoped = applyPatches(rest, CSS_PATCHES, "style.css");
writeFileSync(
  join(OUT, "style.css"),
  `/* VENDORED from porta-git-manager/style.css — do not edit by hand. */\n` +
    `${globals}\n\n@scope (.gm-root) {\n${scoped}\n}\n`,
);

const markup = extractMarkup(readFileSync(join(SRC, "index.html"), "utf8"));
writeFileSync(
  join(OUT, "markup.ts"),
  banner("index.html") + `\nexport const GIT_MANAGER_MARKUP = ${JSON.stringify(markup)};\n`,
);

const version = JSON.parse(readFileSync(join(SRC, "porta.json"), "utf8")).version;
writeFileSync(join(OUT, "VERSION"), `${version}\n`);
console.log(`vendored porta-git-manager v${version} → src/vendor/git-manager/`);
