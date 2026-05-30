import { test } from "node:test";
import assert from "node:assert/strict";
import { detectConfigPath } from "../lib/config.js";

function shellWithExisting(paths) {
  return async (cmd) => {
    const m = cmd.match(/test -f '([^']+)'/);
    const path = m && m[1];
    return { code: paths.includes(path) ? 0 : 1, stdout: "", stderr: "" };
  };
}

test("prefers config/deploy.yml", async () => {
  const run = shellWithExisting(["/srv/app/config/deploy.yml", "/srv/app/deploy.yml"]);
  assert.equal(await detectConfigPath(run, "/srv/app", null), "/srv/app/config/deploy.yml");
});
test("falls back to top-level deploy.yml", async () => {
  const run = shellWithExisting(["/srv/app/deploy.yml"]);
  assert.equal(await detectConfigPath(run, "/srv/app", null), "/srv/app/deploy.yml");
});
test("override wins when present", async () => {
  const run = shellWithExisting(["/srv/app/custom/deploy.yml", "/srv/app/config/deploy.yml"]);
  assert.equal(await detectConfigPath(run, "/srv/app", "/srv/app/custom/deploy.yml"), "/srv/app/custom/deploy.yml");
});
test("override ignored when missing", async () => {
  const run = shellWithExisting(["/srv/app/config/deploy.yml"]);
  assert.equal(await detectConfigPath(run, "/srv/app", "/nope/deploy.yml"), "/srv/app/config/deploy.yml");
});
test("nothing found → null", async () => {
  const run = shellWithExisting([]);
  assert.equal(await detectConfigPath(run, "/srv/app", null), null);
});
