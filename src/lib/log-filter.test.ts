import { describe, it, expect } from "vitest";
import {
  parseFilter,
  matchesFilter,
  blockMatchesFilter,
  buildHighlightRegex,
} from "./log-filter";

function lines(...texts: string[]) {
  return texts.map((t) => ({ lower: t.toLowerCase() }));
}

describe("parseFilter", () => {
  it("returns null when there is nothing to filter on", () => {
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("   ")).toBeNull();
    // Someone mid-typing an exclusion, not an empty exclusion.
    expect(parseFilter("-")).toBeNull();
  });

  it("splits bare terms and lower-cases them", () => {
    expect(parseFilter("Timeout POST")).toEqual({
      include: ["timeout", "post"],
      exclude: [],
    });
  });

  it("treats a leading dash as an exclusion", () => {
    expect(parseFilter("query -SELECT")).toEqual({
      include: ["query"],
      exclude: ["select"],
    });
  });

  it("keeps quoted phrases whole, negated or not", () => {
    expect(parseFilter('"connection refused" -"health check"')).toEqual({
      include: ["connection refused"],
      exclude: ["health check"],
    });
  });

  it("recovers from an unterminated quote", () => {
    expect(parseFilter('"conn')).toEqual({ include: ["conn"], exclude: [] });
  });

  it("leaves a quote inside a token alone", () => {
    // `foo"bar` is a literal someone typed, not a phrase delimiter.
    expect(parseFilter('foo"bar')).toEqual({ include: ['foo"bar'], exclude: [] });
  });

  it("is not confused by leftover state across calls", () => {
    // The tokenizer regex is module-level and global; a stale lastIndex would
    // make every other call skip the head of the query.
    expect(parseFilter("alpha")).toEqual({ include: ["alpha"], exclude: [] });
    expect(parseFilter("alpha")).toEqual({ include: ["alpha"], exclude: [] });
    expect(parseFilter("beta")).toEqual({ include: ["beta"], exclude: [] });
  });
});

describe("matchesFilter", () => {
  const f = parseFilter("timeout -health")!;

  it("requires every include term", () => {
    expect(matchesFilter("request timeout after 30s", f)).toBe(true);
    expect(matchesFilter("request completed", f)).toBe(false);
  });

  it("rejects on any exclude term", () => {
    expect(matchesFilter("health probe timeout", f)).toBe(false);
  });

  it("ANDs multiple include terms", () => {
    const two = parseFilter("post /api")!;
    expect(matchesFilter("post /api/users 200", two)).toBe(true);
    expect(matchesFilter("get /api/users 200", two)).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(matchesFilter("REQUEST TIMEOUT".toLowerCase(), f)).toBe(true);
  });
});

describe("blockMatchesFilter", () => {
  // A leveled header plus its continuation lines — the shape the log viewer
  // groups by.
  const block = lines(
    "[error] Postgrex.Error during query",
    "    SELECT * FROM users WHERE id = $1",
    "    ↳ MyApp.Repo.get/2, at: lib/my_app/repo.ex:14",
  );

  it("matches a term found on a continuation line, not just the header", () => {
    const f = parseFilter("error users")!;
    expect(blockMatchesFilter(block, 0, block.length, f)).toBe(true);
  });

  it("fails when one include term appears nowhere in the entry", () => {
    const f = parseFilter("error nonexistent")!;
    expect(blockMatchesFilter(block, 0, block.length, f)).toBe(false);
  });

  it("drops the whole entry when an exclude term hits any line of it", () => {
    // Hiding the header while leaving its orphaned stacktrace behind is never
    // what "don't show me this" meant.
    const f = parseFilter("error -SELECT")!;
    expect(blockMatchesFilter(block, 0, block.length, f)).toBe(false);
  });

  it("respects the slice bounds", () => {
    const buf = lines("alpha header", "alpha body", "beta header", "beta body");
    const f = parseFilter("beta")!;
    expect(blockMatchesFilter(buf, 0, 2, f)).toBe(false);
    expect(blockMatchesFilter(buf, 2, 4, f)).toBe(true);
  });
});

describe("buildHighlightRegex", () => {
  it("returns null when there is nothing to mark", () => {
    expect(buildHighlightRegex([])).toBeNull();
    expect(buildHighlightRegex([""])).toBeNull();
  });

  it("escapes regex metacharacters so a literal query stays literal", () => {
    const re = buildHighlightRegex(["a.b(c)"])!;
    expect("a.b(c)".split(re)).toEqual(["", "a.b(c)", ""]);
    expect("axbXcY".split(re)).toEqual(["axbXcY"]);
  });

  it("splits into [text, hit, text, …] so odd slots are the matches", () => {
    const re = buildHighlightRegex(["err"])!;
    expect("an err here".split(re)).toEqual(["an ", "err", " here"]);
  });

  it("marks every occurrence, case-insensitively", () => {
    const re = buildHighlightRegex(["err"])!;
    expect("Err and err".split(re)).toEqual(["", "Err", " and ", "err", ""]);
  });

  it("prefers the longest term when two overlap at the same offset", () => {
    // Alternation is first-match-wins, so an unsorted `foo|foobar` would only
    // ever mark the `foo` prefix.
    const re = buildHighlightRegex(["foo", "foobar"])!;
    expect("a foobar b".split(re)).toEqual(["a ", "foobar", " b"]);
  });
});
