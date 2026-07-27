import { describe, expect, it } from "vitest";
import { detectBlocker } from "./log-blockers";

describe("detectBlocker", () => {
  it("finds a pid holding a lock", () => {
    expect(detectBlocker(["Waiting for lock, held by process 41234"])).toEqual({
      kind: "pid",
      pid: 41234,
      label: "Lock held by pid 41234",
    });
    expect(detectBlocker(["error: Another instance is running (pid 999)"])).toMatchObject({
      kind: "pid",
      pid: 999,
    });
  });

  // The whole reason this file exists: EADDRINUSE is what actually shows up
  // when a crashed run leaves the port bound, and the old `held by process (\d+)`
  // regex never matched a word of it, so the kill button never appeared.
  it("finds the port from the shapes runtimes really print", () => {
    expect(detectBlocker(["Error: listen EADDRINUSE: address already in use :::4000"])).toMatchObject({
      kind: "port",
      port: 4000,
    });
    expect(detectBlocker(["Port 3000 is in use, trying another one..."])).toMatchObject({
      kind: "port",
      port: 3000,
    });
    expect(
      detectBlocker(["Address already in use - bind(2) for 127.0.0.1:3000 (Errno::EADDRINUSE)"]),
    ).toMatchObject({ kind: "port" });
  });

  it("knows the port is taken even when the message doesn't name it", () => {
    expect(
      detectBlocker(["[error] Failed to start Ranch listener with :eaddrinuse in :ranch_tcp"]),
    ).toEqual({ kind: "port", port: null, label: "That port is already in use" });
  });

  it("reports the newest blocker, not the first", () => {
    const lines = [
      "listen EADDRINUSE: address already in use :::4000",
      "retrying…",
      "Waiting for lock, held by process 7",
    ];
    expect(detectBlocker(lines)).toMatchObject({ kind: "pid", pid: 7 });
  });

  it("ignores ordinary output", () => {
    expect(detectBlocker(["Listening on http://localhost:4000", "compiled in 320ms"])).toBeNull();
  });

  it("only looks at the tail — an hour-old failure isn't why this boot died", () => {
    const lines = ["listen EADDRINUSE :::4000", ...Array(60).fill("ok")];
    expect(detectBlocker(lines)).toBeNull();
  });
});
