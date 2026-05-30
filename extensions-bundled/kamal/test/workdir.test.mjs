import { test } from "node:test";
import assert from "node:assert/strict";
import { kamalWorkDir } from "../lib/workdir.js";

test("config/deploy.yml → project root (two up)", () => {
  assert.equal(kamalWorkDir("/srv/app/config/deploy.yml"), "/srv/app");
});
test("top-level deploy.yml → its directory (one up)", () => {
  assert.equal(kamalWorkDir("/srv/app/deploy.yml"), "/srv/app");
});
test("bare deploy.yml → '/'", () => {
  assert.equal(kamalWorkDir("/deploy.yml"), "/");
});
