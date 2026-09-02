import { describe, it, expect, beforeEach, vi } from "vitest";

const readExtensionFile = vi.fn();

vi.mock("../../lib/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/commands")>()),
  readExtensionFile: (path: string) => readExtensionFile(path),
}));

// Only the module-level bundle cache is under test here; the component itself
// needs a DOM, an iframe and the Tauri bridge, none of which this touches.
const { invalidateExtensionBundle, __loadInlinedBundleForTest: load } = await import("./ExtensionPanel");

const MAIN = "/ext/git-manager/index.html";
const HTML = `<html><head>
<link rel="stylesheet" href="style.css">
</head><body>
<script src="app.js"></script>
<script src="util.js"></script>
</body></html>`;

const FILES: Record<string, string> = {
  [MAIN]: HTML,
  "/ext/git-manager/style.css": "body{color:red}",
  "/ext/git-manager/app.js": "console.log('app')",
  "/ext/git-manager/util.js": "console.log('util')",
};

beforeEach(() => {
  invalidateExtensionBundle();
  readExtensionFile.mockReset();
  readExtensionFile.mockImplementation((p: string) =>
    p in FILES ? Promise.resolve(FILES[p]) : Promise.reject(new Error(`missing ${p}`)),
  );
});

describe("extension bundle cache", () => {
  it("inlines every stylesheet and script into the html", async () => {
    const out = await load(MAIN, "1.0.0");
    expect(out).toContain("<style data-inlined-from=\"style.css\">");
    expect(out).toContain("body{color:red}");
    expect(out).toContain("console.log('app')");
    expect(out).toContain("console.log('util')");
    // The original external references are gone — the srcdoc is self-contained.
    expect(out).not.toContain('href="style.css"');
    expect(out).not.toContain('src="app.js"');
  });

  it("reads each asset once, however many times a panel opens", async () => {
    await load(MAIN, "1.0.0");
    const afterFirst = readExtensionFile.mock.calls.length;
    expect(afterFirst).toBe(4); // index.html + 3 assets

    // Reopening, or opening the same extension against a different app, used
    // to repeat all four reads — that is the cost this cache exists to remove.
    await load(MAIN, "1.0.0");
    await load(MAIN, "1.0.0");
    expect(readExtensionFile.mock.calls.length).toBe(afterFirst);
  });

  it("shares one read between panels that open at the same time", async () => {
    await Promise.all([load(MAIN, "1.0.0"), load(MAIN, "1.0.0")]);
    expect(readExtensionFile.mock.calls.length).toBe(4);
  });

  it("re-reads after a version bump", async () => {
    await load(MAIN, "1.0.0");
    await load(MAIN, "1.0.1");
    expect(readExtensionFile.mock.calls.length).toBe(8);
  });

  it("re-reads after an explicit invalidate, which is what Reload does", async () => {
    await load(MAIN, "1.0.0");
    invalidateExtensionBundle(MAIN);
    await load(MAIN, "1.0.0");
    expect(readExtensionFile.mock.calls.length).toBe(8);
  });

  it("does not cache a failed load", async () => {
    readExtensionFile.mockRejectedValueOnce(new Error("boom"));
    await expect(load(MAIN, "1.0.0")).rejects.toThrow("boom");
    const out = await load(MAIN, "1.0.0");
    expect(out).toContain("console.log('app')");
  });

  it("keeps the original tag when one asset fails, rather than failing the panel", async () => {
    readExtensionFile.mockImplementation((p: string) =>
      p === "/ext/git-manager/util.js"
        ? Promise.reject(new Error("gone"))
        : Promise.resolve(FILES[p]),
    );
    const out = await load(MAIN, "1.0.0");
    expect(out).toContain("console.log('app')");
    expect(out).toContain('src="util.js"');
  });
});
