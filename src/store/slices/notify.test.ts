import { describe, it, expect, beforeEach } from "vitest";
import { usePortaStore } from "../index";
import { errorText } from "./notify";

function reset() {
  usePortaStore.setState({ notices: [] });
}

describe("notify slice", () => {
  beforeEach(reset);

  it("keeps errors until dismissed but auto-expires successes", () => {
    const { notify } = usePortaStore.getState();
    notify({ kind: "error", message: "boom" });
    notify({ kind: "success", message: "saved" });

    const [err, ok] = usePortaStore.getState().notices;
    expect(err.timeout).toBeNull();
    expect(ok.timeout).toBeGreaterThan(0);
  });

  it("carries the backend reason as detail instead of dropping it", () => {
    usePortaStore.getState().notifyError("Failed to start web", new Error("port 4000 in use"));
    const [n] = usePortaStore.getState().notices;
    expect(n.kind).toBe("error");
    expect(n.message).toBe("Failed to start web");
    expect(n.detail).toBe("port 4000 in use");
  });

  it("dismisses only the targeted notice", () => {
    const { notify, dismissNotice } = usePortaStore.getState();
    const a = notify({ kind: "info", message: "a" });
    notify({ kind: "info", message: "b" });
    dismissNotice(a);
    expect(usePortaStore.getState().notices.map((n) => n.message)).toEqual(["b"]);
  });

  it("truncates a runaway error body so the toast stays readable", () => {
    const long = "x".repeat(5000);
    expect(errorText(new Error(long)).length).toBeLessThan(long.length);
    expect(errorText(new Error(long)).endsWith("…")).toBe(true);
  });

  it("stringifies non-Error rejections (Tauri rejects with plain strings)", () => {
    expect(errorText("authentication failed")).toBe("authentication failed");
  });
});
