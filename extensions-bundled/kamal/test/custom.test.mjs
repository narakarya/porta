import { test } from "node:test";
import assert from "node:assert/strict";
import { CustomStore } from "../lib/custom.js";

function fakeStorage() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, v); },
    _m: m,
  };
}

test("add → list → remove round-trip", async () => {
  const store = new CustomStore(fakeStorage());
  await store.add({ label: "Console", args: ["console"], interactive: true });
  let list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].label, "Console");
  assert.ok(list[0].id, "id assigned");
  await store.remove(list[0].id);
  list = await store.list();
  assert.equal(list.length, 0);
});
test("update mutates by id", async () => {
  const store = new CustomStore(fakeStorage());
  await store.add({ label: "A", args: ["a"], interactive: false });
  const [item] = await store.list();
  await store.update(item.id, { label: "B", args: ["b"], interactive: true });
  const [updated] = await store.list();
  assert.equal(updated.label, "B");
  assert.deepEqual(updated.args, ["b"]);
  assert.equal(updated.interactive, true);
});
test("toCommandDefs maps to sidebar command shape", async () => {
  const store = new CustomStore(fakeStorage());
  await store.add({ label: "X", args: ["x"], interactive: true });
  const list = await store.list();
  const defs = store.toCommandDefs(list);
  assert.equal(defs[0].group, "Custom");
  assert.equal(defs[0].id, `custom-${list[0].id}`);
  assert.equal(defs[0].interactive, true);
});
