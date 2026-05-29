# Git Manager UI/UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rombak tampilan & UX ekstensi Git Manager (7 tab) — diff dengan gutter nomor baris + word-level + syntax highlight, list seragam dengan selection kuat + search-match highlight, dan polish sistemik — tanpa mengubah perilaku git apa pun.

**Architecture:** Ekstensi vanila (HTML+JS+CSS, tanpa build) di `extensions-bundled/git-manager/`. Logika murni baru diekstrak ke tiga modul UMD (`text-util.js`, `diff-util.js`, `highlight.js`) yang di-load di `index.html` sebelum `app.js` dan diuji via `node --test`. CSS ditulis ulang mengikuti satu sistem token. Rendering di `app.js` disesuaikan untuk memakai modul baru. Fallback polos menjaga diff tidak pernah rusak.

**Tech Stack:** JavaScript vanila (browser + Node untuk test), CSS, SVG inline. Test pakai `node:test` + `node:assert`. Tidak ada library eksternal.

---

## File Structure

| File | Tanggung jawab |
|------|----------------|
| `extensions-bundled/git-manager/text-util.js` | **Create.** `escapeHtml`, `highlightMatches` (search-match → `<mark>`). Murni. |
| `extensions-bundled/git-manager/diff-util.js` | **Create.** `parseHunkHeader`, `numberHunkLines` (gutter), `wordDiff` (word-level). Murni. |
| `extensions-bundled/git-manager/highlight.js` | **Create.** `langFromPath`, `tokenize` (syntax). Murni, regex-based. |
| `extensions-bundled/git-manager/test/*.test.mjs` | **Create.** Test untuk tiga modul di atas. |
| `extensions-bundled/git-manager/index.html` | **Modify.** Load 3 modul baru sebelum `app.js`; markup minor. |
| `extensions-bundled/git-manager/style.css` | **Modify (rewrite).** Sistem token, list seragam, diff, polish per-tab. |
| `extensions-bundled/git-manager/app.js` | **Modify.** Integrasi gutter/word/syntax di diff; search-match di filter; kelas baris seragam. |
| `extensions-bundled/git-manager/porta.json` | **Modify.** Bump versi → `0.5.0`. |
| `extensions-bundled/git-manager/README.md` | **Modify.** Catat perubahan UI. |

Urutan: modul murni (TDD) → CSS sistem → integrasi diff → search-match → polish per-tab → versi/README/validasi.

---

## Phase 1 — Modul murni (TDD)

### Task 1: `text-util.js` — escape + search-match highlight

**Files:**
- Create: `extensions-bundled/git-manager/text-util.js`
- Test: `extensions-bundled/git-manager/test/text-util.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// extensions-bundled/git-manager/test/text-util.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../text-util.js";
const { escapeHtml, highlightMatches } = pkg;

test("escapeHtml escapes the dangerous five", () => {
  assert.equal(escapeHtml(`<a href="x" id='y'>&</a>`),
    "&lt;a href=&quot;x&quot; id=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});

test("highlightMatches with empty query just escapes", () => {
  assert.equal(highlightMatches("a<b>", ""), "a&lt;b&gt;");
});

test("highlightMatches wraps case-insensitive matches in mark", () => {
  assert.equal(highlightMatches("FooBar", "bar"),
    "Foo<mark class=\"hl\">Bar</mark>");
});

test("highlightMatches escapes before marking (no XSS via filename)", () => {
  assert.equal(highlightMatches("<script>", "script"),
    "&lt;<mark class=\"hl\">script</mark>&gt;");
});

test("highlightMatches handles multiple matches", () => {
  assert.equal(highlightMatches("aXaXa", "x"),
    "a<mark class=\"hl\">X</mark>a<mark class=\"hl\">X</mark>a");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extensions-bundled/git-manager/test/text-util.test.mjs`
Expected: FAIL — `Cannot find module ../text-util.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// extensions-bundled/git-manager/text-util.js
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMText = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Escape first, then wrap matches of `query` (case-insensitive) in <mark>.
  // Operates on the ORIGINAL string for matching, emits escaped segments.
  function highlightMatches(text, query) {
    const src = String(text);
    if (!query) return escapeHtml(src);
    const q = String(query).toLowerCase();
    const lower = src.toLowerCase();
    let out = "";
    let i = 0;
    while (i < src.length) {
      const hit = lower.indexOf(q, i);
      if (hit === -1) { out += escapeHtml(src.slice(i)); break; }
      out += escapeHtml(src.slice(i, hit));
      out += '<mark class="hl">' + escapeHtml(src.slice(hit, hit + q.length)) + "</mark>";
      i = hit + q.length;
    }
    return out;
  }

  return { escapeHtml, highlightMatches };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extensions-bundled/git-manager/test/text-util.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add extensions-bundled/git-manager/text-util.js extensions-bundled/git-manager/test/text-util.test.mjs
rtk git commit -m "feat(git-manager): add text-util (escape + search-match highlight)"
```

---

### Task 2: `diff-util.js` — hunk header parse + gutter line numbers

**Files:**
- Create: `extensions-bundled/git-manager/diff-util.js`
- Test: `extensions-bundled/git-manager/test/diff-util.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// extensions-bundled/git-manager/test/diff-util.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../diff-util.js";
const { parseHunkHeader, numberHunkLines, wordDiff } = pkg;

test("parseHunkHeader reads both ranges", () => {
  assert.deepEqual(parseHunkHeader("@@ -12,6 +12,7 @@ render()"),
    { oldStart: 12, oldCount: 6, newStart: 12, newCount: 7 });
});

test("parseHunkHeader defaults count to 1 when omitted", () => {
  assert.deepEqual(parseHunkHeader("@@ -5 +6 @@"),
    { oldStart: 5, oldCount: 1, newStart: 6, newCount: 1 });
});

test("numberHunkLines assigns running old/new numbers", () => {
  const lines = [" ctx", "-gone", "+new", " tail"];
  const rows = numberHunkLines(lines, { oldStart: 10, newStart: 10 });
  assert.deepEqual(rows, [
    { kind: "ctx", text: " ctx",  oldNo: 10, newNo: 10 },
    { kind: "del", text: "-gone", oldNo: 11, newNo: null },
    { kind: "add", text: "+new",  oldNo: null, newNo: 11 },
    { kind: "ctx", text: " tail", oldNo: 12, newNo: 12 },
  ]);
});

test("numberHunkLines marks no-newline meta lines", () => {
  const rows = numberHunkLines(["\\ No newline at end of file"], { oldStart: 1, newStart: 1 });
  assert.equal(rows[0].kind, "meta");
  assert.equal(rows[0].oldNo, null);
  assert.equal(rows[0].newNo, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extensions-bundled/git-manager/test/diff-util.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation (parse + number; wordDiff stub added in Task 3)**

```js
// extensions-bundled/git-manager/diff-util.js
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMDiff = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function parseHunkHeader(header) {
    const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!m) return { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 };
    return {
      oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2],
      newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4],
    };
  }

  // Walk hunk body lines, attach running old/new line numbers.
  function numberHunkLines(lines, range) {
    let oldNo = range.oldStart, newNo = range.newStart;
    const rows = [];
    for (const text of lines) {
      const c = text[0];
      if (c === "\\") { rows.push({ kind: "meta", text, oldNo: null, newNo: null }); continue; }
      if (c === "-") { rows.push({ kind: "del", text, oldNo: oldNo++, newNo: null }); continue; }
      if (c === "+") { rows.push({ kind: "add", text, oldNo: null, newNo: newNo++ }); continue; }
      rows.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
    }
    return rows;
  }

  // Placeholder — real impl in Task 3. Returns whole-line as unchanged.
  function wordDiff(delText, addText) {
    return { del: [{ t: delText, changed: false }], add: [{ t: addText, changed: false }] };
  }

  return { parseHunkHeader, numberHunkLines, wordDiff };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extensions-bundled/git-manager/test/diff-util.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add extensions-bundled/git-manager/diff-util.js extensions-bundled/git-manager/test/diff-util.test.mjs
rtk git commit -m "feat(git-manager): add diff-util hunk parse + gutter line numbers"
```

---

### Task 3: `diff-util.js` — word-level diff (LCS over tokens)

**Files:**
- Modify: `extensions-bundled/git-manager/diff-util.js` (replace `wordDiff`)
- Test: `extensions-bundled/git-manager/test/diff-util.test.mjs` (append)

- [ ] **Step 1: Write the failing test (append to existing file)**

```js
test("wordDiff marks only changed tokens", () => {
  // del/add text include the leading -/+ which wordDiff strips internally
  const r = wordDiff("-let total = 0", "+let sum = 0");
  const changedDel = r.del.filter(x => x.changed).map(x => x.t).join("");
  const changedAdd = r.add.filter(x => x.changed).map(x => x.t).join("");
  assert.equal(changedDel, "total");
  assert.equal(changedAdd, "sum");
  // unchanged tokens reconstruct the rest
  assert.equal(r.del.map(x => x.t).join(""), "let total = 0");
  assert.equal(r.add.map(x => x.t).join(""), "let sum = 0");
});

test("wordDiff on identical bodies marks nothing changed", () => {
  const r = wordDiff("-same line", "+same line");
  assert.ok(r.del.every(x => !x.changed));
  assert.ok(r.add.every(x => !x.changed));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extensions-bundled/git-manager/test/diff-util.test.mjs`
Expected: FAIL — `changedDel` is `""` (stub marks nothing changed) ≠ `"total"`.

- [ ] **Step 3: Replace the `wordDiff` placeholder with the real implementation**

```js
  // Tokenize into words + separators so whitespace/punct align naturally.
  function tokenizeWords(s) {
    return s.match(/\w+|\s+|[^\w\s]/g) || [];
  }

  // Word-level diff via LCS. Input lines include the leading -/+ which we strip.
  function wordDiff(delText, addText) {
    const a = tokenizeWords(delText.slice(1));
    const b = tokenizeWords(addText.slice(1));
    const n = a.length, m = b.length;
    // LCS length table
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const del = [], add = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { del.push({ t: a[i], changed: false }); add.push({ t: b[j], changed: false }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { del.push({ t: a[i++], changed: true }); }
      else { add.push({ t: b[j++], changed: true }); }
    }
    while (i < n) del.push({ t: a[i++], changed: true });
    while (j < m) add.push({ t: b[j++], changed: true });
    return { del, add };
  }
```

(Delete the old placeholder `wordDiff`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extensions-bundled/git-manager/test/diff-util.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add extensions-bundled/git-manager/diff-util.js extensions-bundled/git-manager/test/diff-util.test.mjs
rtk git commit -m "feat(git-manager): word-level diff via token LCS"
```

---

### Task 4: `highlight.js` — language detection + syntax tokenizer

**Files:**
- Create: `extensions-bundled/git-manager/highlight.js`
- Test: `extensions-bundled/git-manager/test/highlight.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// extensions-bundled/git-manager/test/highlight.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import pkg from "../highlight.js";
const { langFromPath, tokenize } = pkg;

test("langFromPath maps known extensions", () => {
  assert.equal(langFromPath("src/a.ts"), "js");
  assert.equal(langFromPath("src/a.tsx"), "js");
  assert.equal(langFromPath("a.json"), "json");
  assert.equal(langFromPath("a.css"), "css");
  assert.equal(langFromPath("a.rs"), "rust");
  assert.equal(langFromPath("a.py"), "python");
});

test("langFromPath returns null for unknown", () => {
  assert.equal(langFromPath("a.xyz"), null);
  assert.equal(langFromPath("Makefile"), null);
});

test("tokenize splits keyword/string/number/comment", () => {
  const toks = tokenize(`const x = "hi" // n`, "js");
  // reconstruct original
  assert.equal(toks.map(t => t.t).join(""), `const x = "hi" // n`);
  const byType = Object.fromEntries(toks.filter(t => t.type).map(t => [t.t.trim(), t.type]));
  assert.equal(byType["const"], "keyword");
  assert.equal(byType['"hi"'], "string");
  assert.equal(byType["// n"], "comment");
});

test("tokenize unknown lang returns one plain token", () => {
  const toks = tokenize("anything at all", null);
  assert.deepEqual(toks, [{ t: "anything at all", type: null }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extensions-bundled/git-manager/test/highlight.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// extensions-bundled/git-manager/highlight.js
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMHi = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const EXT = {
    js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js",
    json: "json", css: "css", scss: "css", less: "css",
    html: "html", htm: "html", xml: "html", vue: "html", svelte: "html",
    md: "md", markdown: "md",
    sh: "shell", bash: "shell", zsh: "shell",
    rs: "rust", py: "python",
  };
  function langFromPath(p) {
    const i = p.lastIndexOf(".");
    if (i === -1) return null;
    return EXT[p.slice(i + 1).toLowerCase()] || null;
  }

  const KEYWORDS = {
    js: /\b(const|let|var|function|return|if|else|for|while|of|in|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|this|super|null|undefined|true|false|switch|case|break|continue|do|yield|delete|void)\b/,
    rust: /\b(fn|let|mut|const|pub|use|mod|struct|enum|impl|trait|match|if|else|for|while|loop|return|self|Self|crate|super|where|async|await|move|ref|as|dyn|true|false|Some|None|Ok|Err)\b/,
    python: /\b(def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|yield|async|await|pass|break|continue|in|is|not|and|or|None|True|False|self)\b/,
    css: /[.#]?[-\w]+(?=\s*\{)|[-a-z]+(?=\s*:)/,
    json: /\btrue\b|\bfalse\b|\bnull\b/,
    html: /<\/?[a-zA-Z][\w-]*/,
    md: /^#{1,6}\s.*$/m,
    shell: /\b(if|then|fi|else|elif|for|while|do|done|case|esac|function|return|export|local|echo|cd|in)\b/,
  };

  // Ordered matchers shared across C-like langs; per-lang keyword swapped in.
  function tokenize(code, lang) {
    if (!lang) return [{ t: code, type: null }];
    const kw = KEYWORDS[lang];
    const toks = [];
    let i = 0;
    const push = (t, type) => { if (t) toks.push({ t, type }); };
    while (i < code.length) {
      const rest = code.slice(i);
      let m;
      // line comment
      if ((lang === "js" || lang === "css" || lang === "rust") && rest.startsWith("//")) {
        const nl = rest.indexOf("\n"); const end = nl === -1 ? rest.length : nl;
        push(rest.slice(0, end), "comment"); i += end; continue;
      }
      if ((lang === "python" || lang === "shell") && rest[0] === "#") {
        const nl = rest.indexOf("\n"); const end = nl === -1 ? rest.length : nl;
        push(rest.slice(0, end), "comment"); i += end; continue;
      }
      // string
      if ((m = /^(["'`])(?:\\.|(?!\1)[^\\])*\1?/.exec(rest))) { push(m[0], "string"); i += m[0].length; continue; }
      // number
      if ((m = /^\b\d[\d_.eE+-]*\b/.exec(rest))) { push(m[0], "number"); i += m[0].length; continue; }
      // keyword
      if (kw && (m = new RegExp("^(?:" + kw.source + ")").exec(rest)) && m[0]) { push(m[0], "keyword"); i += m[0].length; continue; }
      // identifier / run of word chars
      if ((m = /^[A-Za-z_]\w*/.exec(rest))) { push(m[0], null); i += m[0].length; continue; }
      // whitespace run
      if ((m = /^\s+/.exec(rest))) { push(m[0], null); i += m[0].length; continue; }
      // single other char
      push(rest[0], null); i += 1;
    }
    return toks;
  }

  return { langFromPath, tokenize };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extensions-bundled/git-manager/test/highlight.test.mjs`
Expected: PASS (4 tests). If the `css`/`md` keyword regexes interfere, they are only consulted via the `^(?:…)` anchor so they never throw; adjust only if a test fails.

- [ ] **Step 5: Commit**

```bash
rtk git add extensions-bundled/git-manager/highlight.js extensions-bundled/git-manager/test/highlight.test.mjs
rtk git commit -m "feat(git-manager): add regex syntax tokenizer + lang detection"
```

---

### Task 5: Load modules in index.html

**Files:**
- Modify: `extensions-bundled/git-manager/index.html:79` (before `<script src="app.js">`)

- [ ] **Step 1: Add the three module scripts before app.js**

Replace the line `  <script src="app.js"></script>` with:

```html
  <script src="text-util.js"></script>
  <script src="diff-util.js"></script>
  <script src="highlight.js"></script>
  <script src="app.js"></script>
```

- [ ] **Step 2: Verify load order manually**

Run: `node -e "require('./extensions-bundled/git-manager/text-util.js'); require('./extensions-bundled/git-manager/diff-util.js'); require('./extensions-bundled/git-manager/highlight.js'); console.log('all load')"`
Expected: prints `all load` with no error.

- [ ] **Step 3: Commit**

```bash
rtk git add extensions-bundled/git-manager/index.html
rtk git commit -m "chore(git-manager): load util modules before app.js"
```

---

## Phase 2 — CSS sistem dasar

### Task 6: Rewrite token system, buttons, states, focus rings

**Files:**
- Modify: `extensions-bundled/git-manager/style.css:1-205` (`:root` + base + common controls)

- [ ] **Step 1: Replace the `:root` block and base controls**

Update `:root` (style.css:2-23) to add the new tokens (keep existing names, append new ones):

```css
:root {
  --bg:#0d0d0f; --bg-pane:#131316; --bg-card:#1a1a1c; --bg-input:#08080a;
  --bg-hover:rgba(255,255,255,.05); --bg-selected:rgba(96,165,250,.12);
  --border:rgba(255,255,255,.06); --border-hi:rgba(255,255,255,.10);
  --text:#e4e4e7; --text-mute:#71717a; --text-dim:#52525b;
  --blue:#60a5fa; --emerald:#34d399; --amber:#fbbf24; --red:#f87171; --violet:#a78bfa; --orange:#fb923c;
  --diff-add-bg:rgba(52,211,153,.08); --diff-del-bg:rgba(248,113,113,.08);
  --diff-add-word:rgba(52,211,153,.26); --diff-del-word:rgba(248,113,113,.26);
  --syn-keyword:#a78bfa; --syn-string:#86efac; --syn-number:#fbbf24; --syn-comment:#52525b;
  --radius-sm:4px; --radius:6px; --radius-md:8px; --radius-lg:10px;
  --act-rest:.55; /* faint-but-visible action affordance */
  --focus:rgba(96,165,250,.55);
}
```

- [ ] **Step 2: Add focus-visible + action affordance rules at end of common controls (after style.css:205)**

```css
/* Visible-at-rest action affordance (replaces opacity:0 patterns) */
.row-actions, .branch-actions, .tag-actions, .stash-actions, .remote-actions, .hunk-actions {
  opacity: var(--act-rest);
  transition: opacity .12s;
}
.file-row:hover .row-actions, .file-row.is-selected .row-actions,
.branch-row:hover .branch-actions, .tag-row:hover .tag-actions,
.stash-row:hover .stash-actions, .remote-row:hover .remote-actions,
.hunk:hover .hunk-actions { opacity: 1; }

:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; border-radius: var(--radius-sm); }
.file-row:focus-visible, .branch-row:focus-visible, .log-row:focus-visible { outline-offset: -2px; }

/* Search-match highlight */
mark.hl { background: rgba(251,191,36,.30); color: var(--amber); border-radius: 2px; padding: 0 1px; }
.file-row.is-selected mark.hl, .branch-row.is-current mark.hl { color: inherit; }
```

- [ ] **Step 3: Manual check**

Run: `npm run tauri dev` if not already running (`lsof -ti:1420` to check). Open an app card → Git. Verify the panel still renders, tabs switch, no obvious breakage (full visual pass comes later).
Expected: panel loads; actions now faintly visible at rest.

- [ ] **Step 4: Commit**

```bash
rtk git add extensions-bundled/git-manager/style.css
rtk git commit -m "feat(git-manager): css token system, focus rings, visible action affordance"
```

---

## Phase 3 — Diff: gutter + word-level + syntax

### Task 7: Unified diff with gutter + word highlight + syntax

**Files:**
- Modify: `extensions-bundled/git-manager/app.js` — `renderDiffInto` (389), `renderUnifiedHunkBody` (415); track `filePath` lang.
- Modify: `extensions-bundled/git-manager/style.css:400-411` (`.diff-line` + new `.diff-gutter`, syntax token classes).

- [ ] **Step 1: Add CSS for gutter + syntax tokens (replace style.css:400-411 diff-line block)**

```css
.diff-line { display:grid; grid-template-columns:34px 34px 1fr; white-space:pre; min-height:18px; }
.diff-line .diff-gutter { color:var(--text-dim); text-align:right; padding-right:8px; user-select:none; font-variant-numeric:tabular-nums; }
.diff-line .diff-code { padding:0 12px 0 6px; }
.diff-line.diff-add { background:var(--diff-add-bg); }
.diff-line.diff-del { background:var(--diff-del-bg); }
.diff-line.diff-add .diff-code { color:var(--emerald); }
.diff-line.diff-del .diff-code { color:var(--red); }
.diff-line.diff-hunk { display:block; color:var(--violet); background:rgba(167,139,250,.05); padding:2px 12px; }
.diff-line.diff-file { display:block; color:var(--blue); font-weight:600; padding:6px 12px 0; }
.diff-line.diff-meta { display:block; color:var(--text-dim); padding:0 12px; }
.wd-del { background:var(--diff-del-word); border-radius:2px; }
.wd-add { background:var(--diff-add-word); border-radius:2px; }
.syn-keyword { color:var(--syn-keyword); } .syn-string { color:var(--syn-string); }
.syn-number { color:var(--syn-number); } .syn-comment { color:var(--syn-comment); font-style:italic; }
```

- [ ] **Step 2: Add a render helper above `renderDiffInto` (app.js, before line 389)**

```js
    // Build the inner code HTML for one diff line: syntax tokens, with
    // optional word-change spans layered on top. `body` excludes the +/-/space
    // prefix. `changedSet` is a Set of token indices flagged by wordDiff, or null.
    function diffCodeHtml(body, lang, wordTokens) {
      const esc = window.GMText.escapeHtml;
      if (wordTokens) {
        // word-level: each token escaped, changed ones wrapped
        return wordTokens.map((w) =>
          w.changed ? '<span class="' + (wordTokens.cls) + '">' + esc(w.t) + "</span>" : esc(w.t)
        ).join("");
      }
      const toks = window.GMHi.tokenize(body, lang);
      return toks.map((t) => t.type ? '<span class="syn-' + t.type + '">' + esc(t.t) + "</span>" : esc(t.t)).join("");
    }
```

- [ ] **Step 3: Replace `renderUnifiedHunkBody` (app.js:415-421)**

```js
    function renderUnifiedHunkBody(wrapper, hunk, lang) {
      const range = window.GMDiff.parseHunkHeader(hunk.header);
      const rows = window.GMDiff.numberHunkLines(hunk.lines, range);
      // Pre-compute word diffs for adjacent del/add singletons.
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k], next = rows[k + 1];
        let wd = null;
        if (r.kind === "del" && next && next.kind === "add") {
          const d = window.GMDiff.wordDiff(r.text, next.text);
          r._wd = d.del; r._wd.cls = "wd-del";
          next._wd = d.add; next._wd.cls = "wd-add";
        }
      }
      for (const r of rows) {
        if (r.kind === "meta") {
          wrapper.appendChild(h("span", { class: "diff-line diff-meta" }, r.text || " "));
          continue;
        }
        const body = r.text.slice(1) || " ";
        const code = h("span", { class: "diff-code", html: diffCodeHtml(body, lang, r._wd || null) });
        wrapper.appendChild(h("span", { class: "diff-line diff-" + r.kind },
          h("span", { class: "diff-gutter" }, r.oldNo == null ? "" : String(r.oldNo)),
          h("span", { class: "diff-gutter" }, r.newNo == null ? "" : String(r.newNo)),
          code,
        ));
      }
    }
```

- [ ] **Step 4: Thread `lang` through `renderDiffInto` (app.js:389-413)**

In `renderDiffInto`, after `node.innerHTML = "";` add:

```js
      const lang = window.GMHi.langFromPath(filePath || "");
```

Change the hunk-body call (app.js:410) from `renderHunkBody(wrapper, hunk);` to:

```js
      renderHunkBody(wrapper, hunk, lang);
```

- [ ] **Step 5: Manual check**

Run (if needed): `npm run tauri dev`. Open Git on an app with changes. In a `.ts`/`.js`/`.json` file: confirm gutter shows old+new line numbers, changed words are emphasized (brighter band) within −/+ lines, and keywords/strings/numbers are colored. Open a file with an unknown extension (e.g. `.lock`): confirm it renders plain with gutter, no crash.
Expected: all of the above; no console errors.

- [ ] **Step 6: Commit**

```bash
rtk git add extensions-bundled/git-manager/app.js extensions-bundled/git-manager/style.css
rtk git commit -m "feat(git-manager): unified diff gutter + word-level + syntax highlight"
```

---

### Task 8: Split diff with gutter + word highlight + syntax

**Files:**
- Modify: `extensions-bundled/git-manager/app.js` — `renderSplitHunkBody` (429+) and its `flush()` (436).
- Modify: `extensions-bundled/git-manager/style.css:473-491` (`.diff-split`, `.diff-cell`).

- [ ] **Step 1: Update split CSS (replace style.css:473-491)**

```css
.diff-split { display:grid; grid-template-columns:1fr 1fr; }
.diff-cell { display:grid; grid-template-columns:30px 1fr; white-space:pre; min-height:18px;
  font-family:ui-monospace,Menlo,monospace; font-size:11px; border-right:1px solid var(--border); }
.diff-cell .diff-gutter { color:var(--text-dim); text-align:right; padding-right:6px; user-select:none; font-variant-numeric:tabular-nums; }
.diff-cell .diff-code { padding:0 8px; }
.diff-cell.diff-cell-right { border-right:0; }
.diff-cell.diff-del .diff-code { color:var(--red); } .diff-cell.diff-del { background:var(--diff-del-bg); }
.diff-cell.diff-add .diff-code { color:var(--emerald); } .diff-cell.diff-add { background:var(--diff-add-bg); }
.diff-cell.diff-blank { background:rgba(255,255,255,.02); }
.diff-cell.diff-meta { color:var(--text-dim); }
```

- [ ] **Step 2: Replace `renderSplitHunkBody` flush logic to emit gutter + word/syntax**

Replace the body of `renderSplitHunkBody` (app.js:429 through its end) with:

```js
    function renderSplitHunkBody(wrapper, hunk, lang) {
      const range = window.GMDiff.parseHunkHeader(hunk.header);
      const grid = h("div", { class: "diff-split" });
      let oldNo = range.oldStart, newNo = range.newStart;
      let dels = [], adds = [];

      function cell(side, kind, no, body, wd) {
        const code = h("span", { class: "diff-code",
          html: body == null ? " " : diffCodeHtml(body || " ", lang, wd || null) });
        return h("span", { class: "diff-cell diff-cell-" + side + " " + (body == null ? "diff-blank" : "diff-" + kind) },
          h("span", { class: "diff-gutter" }, no == null ? "" : String(no)), code);
      }

      function flush() {
        const n = Math.max(dels.length, adds.length);
        for (let i = 0; i < n; i++) {
          const left = i < dels.length ? dels[i] : null;
          const right = i < adds.length ? adds[i] : null;
          let lwd = null, rwd = null;
          if (left && right) { const d = window.GMDiff.wordDiff(left.text, right.text); lwd = d.del; lwd.cls = "wd-del"; rwd = d.add; rwd.cls = "wd-add"; }
          grid.append(
            cell("left", "del", left ? left.no : null, left ? left.text.slice(1) : null, lwd),
            cell("right", "add", right ? right.no : null, right ? right.text.slice(1) : null, rwd),
          );
        }
        dels = []; adds = [];
      }

      for (const line of hunk.lines) {
        const c = line[0];
        if (c === "-") { dels.push({ text: line, no: oldNo++ }); }
        else if (c === "+") { adds.push({ text: line, no: newNo++ }); }
        else if (c === "\\") { /* no-newline marker: ignore in split */ }
        else {
          flush();
          grid.append(
            cell("left", "ctx", oldNo, line.slice(1), null),
            cell("right", "ctx", newNo, line.slice(1), null),
          );
          oldNo++; newNo++;
        }
      }
      flush();
      wrapper.appendChild(grid);
    }
```

Note: `diffCodeHtml`'s word-token branch uses `wordTokens.cls`; the `cls` is set on the array (`lwd.cls = "wd-del"`) — keep that assignment.

- [ ] **Step 3: Manual check**

Run (if needed): `npm run tauri dev`. Status tab → toggle to **Split**. Confirm: each side has its own gutter number, context lines mirror with matching numbers, changed words emphasized, syntax colors present, blank spill cells render greyed.
Expected: split view matches unified quality; no console errors.

- [ ] **Step 4: Commit**

```bash
rtk git add extensions-bundled/git-manager/app.js extensions-bundled/git-manager/style.css
rtk git commit -m "feat(git-manager): split diff gutter + word-level + syntax highlight"
```

---

## Phase 4 — Search-match highlight di list

### Task 9: Status file filter — highlight matches

**Files:**
- Modify: `extensions-bundled/git-manager/app.js` — `fileLabel` (594-600) and its call in `renderFileRow` (611), passing the active filter.

- [ ] **Step 1: Update `fileLabel` to accept + highlight the filter**

Replace `fileLabel` (app.js:594-600):

```js
    function fileLabel(file, filter) {
      const { dir, name } = splitPath(file.path);
      const hl = window.GMText.highlightMatches;
      return h("span", { class: "file-path", title: file.path },
        dir && h("span", { class: "file-dir", html: hl(dir, filter) }),
        h("span", { class: "file-name", html: hl(name, filter) }),
      );
    }
```

- [ ] **Step 2: Pass the filter from `renderFileRow`**

In `renderFileRow` (app.js:602), change the signature to `function renderFileRow(file, source, diffNode, filter)` and the `fileLabel(file)` call (app.js:611) to `fileLabel(file, filter)`. At the call sites (app.js:682, 694) pass the lowercased filter already computed as `filter` in scope (`const filter = (state.fileFilter || "").toLowerCase();` exists near line 636 — reuse it): `renderFileRow(f, "staged", diffNode, filter)` and `renderFileRow(f, "unstaged", diffNode, filter)`.

- [ ] **Step 3: Manual check**

Run (if needed): `npm run tauri dev`. Status tab → type in the filter box. Confirm matching substrings in file paths are highlighted (amber `mark`), selection still works, no broken HTML when a path contains `<` or `&` (test by creating a file named e.g. `a&b.txt`).
Expected: highlights appear; no XSS / broken markup.

- [ ] **Step 4: Commit**

```bash
rtk git add extensions-bundled/git-manager/app.js
rtk git commit -m "feat(git-manager): highlight search matches in status file list"
```

---

### Task 10: Branches, History, Tags — highlight matches + empty states

**Files:**
- Modify: `extensions-bundled/git-manager/app.js` — branch row (863), history log row, tag row render sites; add empty-filter messages.

- [ ] **Step 1: Branch name highlight**

At the branch-name render (app.js:863), replace `h("span", { class: "branch-name", title: b.name }, b.name)` with:

```js
        h("span", { class: "branch-name", title: b.name, html: window.GMText.highlightMatches(b.name, state.branchFilter.toLowerCase()) }),
```

- [ ] **Step 2: History highlight**

History search state key is `state.historyFilter` (verified: app.js:1139-1140; filtering is server-side via `loadLog(state.historyFilter)`). At the history log-message render (app.js:1167, the `log-msg-line` span), replace `h("span", { class: "log-msg-line", title: c.msg }, c.msg)` with:

```js
        h("span", { class: "log-msg-line", title: c.msg, html: window.GMText.highlightMatches(c.msg, (state.historyFilter || "").toLowerCase()) }),
```

Note: the rebase pane also renders a `log-msg-line` (app.js:1305) — do NOT change that one (no search there).

- [ ] **Step 3: Tags highlight**

Tags filter is a LOCAL closure variable `filter` (NOT in `state`), lowercased as `f`; tag render at app.js:1528. Replace `h("span", { class: "tag-name", title: t.name }, t.name)` with:

```js
        h("span", { class: "tag-name", title: t.name, html: window.GMText.highlightMatches(t.name, f) }),
```

(`f` is already in scope from `const f = filter.toLowerCase();` at app.js:1519.) The Tags empty state already exists (app.js:1523, "No tags match") — leave it.

- [ ] **Step 4: Empty-filter message for branches**

Branches has no empty-filter message yet. Where the branches list is built (after `filteredLocal`/`filteredRemote` are computed, ~app.js:857), append a friendly row when both are empty but a filter is active:

```js
      if (filteredLocal.length === 0 && filteredRemote.length === 0 && state.branchFilter) {
        list.append(h("div", { class: "empty-files" }, "Tidak ada branch yang cocok dengan “" + state.branchFilter + "”."));
      }
```

(Status already shows its own empty state via `.empty-files`; History is server-filtered so an empty result is naturally empty — no change needed there.)

- [ ] **Step 5: Manual check**

Run (if needed): `npm run tauri dev`. In Branches, History, Tags: type a query → matches highlight; in Branches type gibberish → friendly empty message appears; in Tags gibberish → existing "No tags match".
Expected: highlight works in all three; empty states behave.

- [ ] **Step 6: Commit**

```bash
rtk git add extensions-bundled/git-manager/app.js
rtk git commit -m "feat(git-manager): search highlight + empty states for branches/history/tags"
```

---

## Phase 5 — Polish per-tab (CSS)

### Task 11: Lists, tabs/topbar, sync, rebase, stash, toast/modal polish

**Files:**
- Modify: `extensions-bundled/git-manager/style.css` — tabs (50-130), file/branch/log/tag/stash/remote rows, sync (524-619), rebase (768-817), toast/modal (877-966).

- [ ] **Step 1: Tabs / badges (no layout shift)**

Replace the `.tab-badge` block (style.css:77-91) so badges reserve space instead of `display:none`:

```css
.tab-badge { font-size:9px; font-weight:600; padding:0 5px; border-radius:8px; background:var(--bg-hover);
  color:var(--text-mute); min-width:14px; text-align:center; line-height:14px; visibility:hidden; }
.tab-badge.show { visibility:visible; }
.tab.is-active .tab-badge { background:rgba(96,165,250,.18); color:var(--blue); }
.tab-badge.urgent { background:rgba(251,191,36,.18); color:var(--amber); visibility:visible; }
```

- [ ] **Step 2: Row template consistency**

Confirm `.file-row`, `.branch-row`, `.tag-row`, `.stash-row`, `.remote-row`, `.log-row` share: `border-left:2px solid transparent`, hover `background:var(--bg-hover)`, selected `background:var(--bg-selected); border-left-color:var(--blue)`. Add the missing `border-left` + selected rules to `.tag-row`, `.stash-row`, `.remote-row` (currently lacking a selected/left-accent treatment) for visual consistency:

```css
.tag-row, .stash-row, .remote-row { border-left:2px solid transparent; }
.tag-row:hover, .stash-row:hover, .remote-row:hover { background:var(--bg-hover); }
```

- [ ] **Step 3: Sync card icons + states; rebase color-coded todos**

Add to the sync section:

```css
.sync-action .name svg { width:13px; height:13px; opacity:.9; }
.sync-action:focus-visible { border-color:var(--blue); }
```

Add rebase action coloring (after style.css:796):

```css
.rebase-todo-row[data-op="squash"] .grip, .rebase-todo-row[data-op="fixup"] .grip { color:var(--amber); }
.rebase-todo-row[data-op="drop"] { opacity:.45; }
.rebase-todo-row select { border-radius:var(--radius-sm); }
```

(If `app.js` doesn't already set `data-op` on the todo row, add `dataset:{op: choice}` where the rebase todo row is built — search `rebase-todo-row` in app.js.)

- [ ] **Step 4: Toast / modal radius + spacing alignment**

Verify toast/modal use `--radius`/`--radius-lg`; update hardcoded `border-radius:6px`/`10px` to the tokens for consistency (style.css:894, 938).

- [ ] **Step 5: Manual full visual pass**

Run (if needed): `npm run tauri dev`. Walk every tab: Status, Branches, Sync, History, Rebase, Stash, Tags. Confirm: badges don't shift layout, rows look consistent, sync running/disabled states clear, rebase ops color-coded, toasts/modals consistent. No console errors.
Expected: cohesive look across all tabs.

- [ ] **Step 6: Commit**

```bash
rtk git add extensions-bundled/git-manager/style.css extensions-bundled/git-manager/app.js
rtk git commit -m "feat(git-manager): per-tab polish — tabs, rows, sync, rebase, toast/modal"
```

---

## Phase 6 — Versi, docs, validasi akhir

### Task 12: Bump version, update README, full validation

**Files:**
- Modify: `extensions-bundled/git-manager/porta.json:4`
- Modify: `extensions-bundled/git-manager/README.md`

- [ ] **Step 1: Bump version**

In `porta.json`, change `"version": "0.4.3"` → `"version": "0.5.0"`.

- [ ] **Step 2: Update README features table**

Add a short note under Features describing: gutter line numbers, word-level + syntax-highlighted diffs, search-match highlighting in all filters, and the refreshed visual system.

- [ ] **Step 3: Run all unit tests**

Run: `node --test extensions-bundled/git-manager/test/`
Expected: all tests PASS (text-util 5, diff-util 6, highlight 4).

- [ ] **Step 4: Full manual regression (per spec §8)**

Run (if needed): `npm run tauri dev`. Exercise, confirming no console errors and all actions still work:
- Status: stage/unstage/discard file + per-hunk (unified & split), commit, amend.
- Branches: filter+highlight, create, switch, delete.
- Sync: fetch/pull/push variants, remote add/edit/rename/remove.
- History: search+highlight, select commit → diff renders with gutter/syntax.
- Rebase: pick a target, set ops (color-coded), reorder; (paused-state if available).
- Stash: save, apply, pop, drop.
- Tags: create, filter+highlight, push, delete.
- Edge cases: clean repo, untracked large file, no remote, unknown file extension diff.

- [ ] **Step 5: Commit**

```bash
rtk git add extensions-bundled/git-manager/porta.json extensions-bundled/git-manager/README.md
rtk git commit -m "chore(git-manager): bump to 0.5.0, document UI overhaul"
```

---

## Self-Review notes (spec coverage)

- Spec §3 (sistem dasar) → Task 6.
- Spec §4.1 gutter → Tasks 7,8. §4.2 word-level → Tasks 3,7,8. §4.3 syntax → Tasks 4,7,8. §4.4 per-hunk actions preserved (not modified; affordance via Task 6).
- Spec §5 list seragam + selection → Tasks 9,10,11. Search-match → Tasks 9,10.
- Spec §6 per-tab polish → Task 11.
- Spec §7 invarian → preserved (no handler/IPC/shortcut changes; presentation only).
- Spec §8 validasi → Task 12.
- Spec §9 risiko → fallback in tokenize (unknown lang → plain), escape-before-mark (Task 1), gutter `user-select:none` + fixed width (Tasks 7,8).
```
