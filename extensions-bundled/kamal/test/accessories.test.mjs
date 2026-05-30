import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAccessories } from "../lib/accessories.js";

const yaml = `
service: myapp
accessories:
  db:
    image: postgres:16
  redis:
    image: redis:7
`;

test("returns accessory names", () => {
  assert.deepEqual(parseAccessories(yaml).sort(), ["db", "redis"]);
});
test("no accessories → []", () => {
  assert.deepEqual(parseAccessories("service: x\n"), []);
});
test("garbage input → []", () => {
  assert.deepEqual(parseAccessories("::: not yaml :::"), []);
});
test("accessories with no children → []", () => {
  assert.deepEqual(parseAccessories("accessories:\nservice: x\n"), []);
});
test("accessories: with trailing comment is still parsed", () => {
  assert.deepEqual(
    parseAccessories("accessories: # sidecars\n  db:\n    image: postgres\n"),
    ["db"]
  );
});
test("comment lines inside the block are ignored", () => {
  assert.deepEqual(
    parseAccessories("accessories:\n  # the database\n  db:\n    image: postgres\n  redis:\n"),
    ["db", "redis"]
  );
});
