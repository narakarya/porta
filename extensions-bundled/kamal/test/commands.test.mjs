import { test } from "node:test";
import assert from "node:assert/strict";
import { FIXED_COMMANDS, buildAccessoryCommands, groupCommands } from "../lib/commands.js";

test("FIXED_COMMANDS includes deploy (confirm) and exec-bash (interactive)", () => {
  const deploy = FIXED_COMMANDS.find((c) => c.id === "deploy");
  assert.equal(deploy.confirm, true);
  assert.deepEqual(deploy.args, ["deploy"]);
  const bash = FIXED_COMMANDS.find((c) => c.id === "exec-bash");
  assert.equal(bash.interactive, true);
});
test("buildAccessoryCommands derives bash + logs per accessory", () => {
  const cmds = buildAccessoryCommands(["db"]);
  assert.deepEqual(cmds.map((c) => c.id), ["acc-bash-db", "acc-logs-db"]);
  assert.equal(cmds[0].interactive, true);
  assert.deepEqual(cmds[1].args, ["accessory", "logs", "db", "-f"]);
});
test("groupCommands buckets by group preserving order", () => {
  const groups = groupCommands(FIXED_COMMANDS);
  assert.ok(groups.has("Deploy"));
  assert.ok(groups.get("Deploy").some((c) => c.id === "deploy"));
});
