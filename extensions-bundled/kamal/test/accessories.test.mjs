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
