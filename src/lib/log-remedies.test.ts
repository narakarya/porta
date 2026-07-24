import { describe, it, expect } from "vitest";
import { detectLogRemedy } from "./log-remedies";

describe("detectLogRemedy", () => {
  it("returns null for ordinary output", () => {
    expect(detectLogRemedy(["[info] Running Endpoint at http://localhost:4000"])).toBeNull();
  });

  it("offers mix deps.get for unchecked dependencies", () => {
    const out = detectLogRemedy([
      "** (Mix) Unchecked dependencies for environment dev:",
      "* phoenix (Hex package)",
    ]);
    expect(out?.command).toBe("mix deps.get");
  });

  it("offers mise trust for an untrusted config", () => {
    const out = detectLogRemedy([
      "mise ERROR Config file /Users/me/app/mise.toml is not trusted. Trust it with `mise trust`.",
    ]);
    expect(out?.command).toBe("mise trust");
  });

  it("picks the package manager out of the start command", () => {
    const lines = ["Error: Cannot find module 'vite'"];
    expect(detectLogRemedy(lines, { startCommand: "pnpm dev" })?.command).toBe("pnpm install");
    expect(detectLogRemedy(lines, { startCommand: "npm run dev" })?.command).toBe("npm install");
    expect(detectLogRemedy(lines)?.command).toBe("npm install");
  });

  it("reports the newest failure, not the first", () => {
    const out = detectLogRemedy([
      "** (Mix) Unchecked dependencies for environment dev:",
      "[info] deps fetched",
      'Run "mix ecto.migrate" to run pending migrations',
    ]);
    expect(out?.command).toBe("mix ecto.migrate");
  });

  it("ignores anything older than the tail window", () => {
    const noise = new Array(50).fill("[info] tick");
    expect(detectLogRemedy(["mise ERROR run `mise trust`", ...noise], {}, 10)).toBeNull();
  });
});
