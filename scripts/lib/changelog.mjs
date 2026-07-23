// Reads and rewrites CHANGELOG.md.
//
// Two shapes matter here. A beta release gets a fresh section seeded from the
// commit subjects since the last beta tag. A stable release consolidates: every
// `X.Y.Z-beta.N` section accumulated since the last stable release is folded
// into one section, merged category by category, because a stable reader wants
// the release as a whole and not eleven beta instalments of it.
//
// Both outputs are drafts. The release script stops after writing them so a
// human can edit before anything is committed.

const SECTION_RE = /^## \[([^\]]+)\](?:\s+—\s+(.*))?\s*$/;
const CATEGORY_RE = /^### (.+?)\s*$/;

/** Category order in generated sections; anything else is appended after. */
const CATEGORY_ORDER = ["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security"];

/**
 * Splits the file into its preamble and its release sections.
 * `preamble` keeps the title and the format/versioning note verbatim.
 */
export function parse(text) {
  const lines = text.split("\n");
  const starts = [];
  lines.forEach((line, i) => {
    if (SECTION_RE.test(line)) starts.push(i);
  });

  if (starts.length === 0) {
    return { preamble: text, sections: [] };
  }

  const preamble = lines.slice(0, starts[0]).join("\n");
  const sections = starts.map((start, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
    const [, version, date] = SECTION_RE.exec(lines[start]);
    return {
      version,
      date: date ?? null,
      body: lines.slice(start + 1, end).join("\n"),
      raw: lines.slice(start, end).join("\n"),
    };
  });

  return { preamble, sections };
}

export function hasVersion(text, version) {
  return parse(text).sections.some((s) => s.version === version);
}

/** Version of the newest section, or null on an empty changelog. */
export function topVersion(text) {
  return parse(text).sections[0]?.version ?? null;
}

export function isBetaVersion(version) {
  return /-beta\.\d+$/.test(version);
}

/**
 * The body of one version's section, trimmed — what the release workflows put
 * in `latest.json`'s `notes`, i.e. the text the update toast shows.
 *
 * Returns null when there is no section for `version`, so the caller can fall
 * back rather than ship an empty release note.
 */
export function sectionFor(text, version) {
  const section = parse(text).sections.find((s) => s.version === version);
  if (!section) return null;
  const body = section.body.trim();
  return body === "" ? null : body;
}

/**
 * Groups a section body into `{ category: [bullet, ...] }`.
 *
 * A bullet is its leading `- ` line plus any indented continuation, so wrapped
 * prose survives the move. Anything else — a lead paragraph like beta.6's
 * "Backports the fixes…" — is returned in `prose` for the caller to warn about
 * rather than silently dropped.
 */
export function splitCategories(body) {
  const categories = new Map();
  const prose = [];
  let current = null;
  let bullet = null;

  const flush = () => {
    if (bullet && current) categories.get(current).push(bullet.join("\n"));
    bullet = null;
  };

  for (const line of body.split("\n")) {
    const heading = CATEGORY_RE.exec(line);
    if (heading) {
      flush();
      current = heading[1];
      if (!categories.has(current)) categories.set(current, []);
      continue;
    }

    if (/^- /.test(line)) {
      flush();
      bullet = [line];
      continue;
    }

    // Indented or blank lines continue the bullet being read; a blank line only
    // counts as continuation if more indented text follows, so trailing blanks
    // between bullets are dropped.
    if (bullet && (/^\s+\S/.test(line) || line.trim() === "")) {
      bullet.push(line);
      continue;
    }

    flush();
    if (line.trim() !== "") prose.push(line.trim());
  }
  flush();

  // Trim blank tails a bullet may have absorbed.
  for (const [name, bullets] of categories) {
    categories.set(
      name,
      bullets.map((b) => b.replace(/\s+$/, "")).filter((b) => b !== ""),
    );
  }

  return { categories, prose };
}

function renderSection(version, date, categories) {
  const names = [
    ...CATEGORY_ORDER.filter((c) => categories.has(c) && categories.get(c).length),
    ...[...categories.keys()]
      .filter((c) => !CATEGORY_ORDER.includes(c) && categories.get(c).length)
      .sort(),
  ];

  const head = date ? `## [${version}] — ${date}` : `## [${version}]`;
  const blocks = names.map((name) => `### ${name}\n\n${categories.get(name).join("\n")}`);
  return [head, ...blocks].join("\n\n") + "\n";
}

/** Rebuilds the file from a preamble and an ordered section list. */
function render(preamble, sections) {
  return [preamble.replace(/\s*$/, "") + "\n", ...sections.map((s) => s.raw.replace(/\s*$/, "") + "\n")].join("\n");
}

/**
 * Folds every leading `-beta.N` section into one stable section.
 *
 * Only the unbroken run of beta sections at the top is consumed — the first
 * released section below them ends the run, so an older stable entry is never
 * rewritten. Returns the new text plus any prose that needs re-adding by hand.
 */
export function consolidateBeta(text, version, date) {
  const { preamble, sections } = parse(text);

  const run = [];
  for (const section of sections) {
    if (!isBetaVersion(section.version)) break;
    run.push(section);
  }

  if (run.length === 0) {
    throw new Error(
      "no beta sections at the top of CHANGELOG.md to consolidate — " +
        "is this line already released, or was the section written by hand?",
    );
  }

  const merged = new Map();
  const warnings = [];

  for (const section of run) {
    const { categories, prose } = splitCategories(section.body);
    for (const [name, bullets] of categories) {
      if (!merged.has(name)) merged.set(name, []);
      merged.get(name).push(...bullets);
    }
    if (prose.length) {
      warnings.push(`[${section.version}] had a lead paragraph that was not carried over: "${prose.join(" ")}"`);
    }
  }

  const section = {
    version,
    date,
    raw: renderSection(version, date, merged),
  };

  return {
    text: render(preamble, [section, ...sections.slice(run.length)]),
    warnings,
    consumed: run.map((s) => s.version),
  };
}

const COMMIT_RE = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

/** Conventional-commit type → changelog category. */
const TYPE_CATEGORY = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  style: "Changed",
  revert: "Changed",
  chore: "Changed",
  docs: "Changed",
};

/**
 * Turns commit subjects into a draft section body. Release commits and merges
 * are dropped; an unrecognised subject lands in Changed rather than vanishing,
 * so nothing is lost before the polish pass.
 */
export function draftFromCommits(subjects) {
  const categories = new Map();

  for (const subject of subjects) {
    if (/^merge[\s:]/i.test(subject)) continue;

    const m = COMMIT_RE.exec(subject);
    if (m && m[1] === "chore" && (m[2] === "release" || /^v?\d+\.\d+\.\d+/.test(m[4]))) continue;

    const category = (m && TYPE_CATEGORY[m[1]]) || "Changed";
    const scope = m?.[2];
    let textPart = m ? m[4] : subject;
    textPart = textPart.charAt(0).toUpperCase() + textPart.slice(1);

    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(scope ? `- **${scope}**: ${textPart}` : `- ${textPart}`);
  }

  return categories;
}

/** Inserts a freshly drafted section above every existing one. */
export function insertSection(text, version, date, categories) {
  const { preamble, sections } = parse(text);
  const section = { version, date, raw: renderSection(version, date, categories) };
  return render(preamble, [section, ...sections]);
}
