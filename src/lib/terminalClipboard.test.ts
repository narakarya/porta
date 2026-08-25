import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Terminal } from "@xterm/xterm";

const copyText = vi.hoisted(() => vi.fn(async () => {}));
const pasteText = vi.hoisted(() => vi.fn(async () => ""));
vi.mock("./clipboard", () => ({ copyText, pasteText }));

// The bridge listens for the Edit-menu events Rust emits; the handlers are
// captured here so a test can fire one without a real Tauri runtime.
const handlers = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: () => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }),
}));

import { registerTerminalPane, installClipboardMenuBridge } from "./terminalClipboard";
import { usePortaStore } from "../store";

/** Just enough of xterm for the clipboard paths. */
function fakeTerm(selection: string) {
  const element = document.createElement("div");
  const textarea = document.createElement("textarea");
  element.appendChild(textarea);
  document.body.appendChild(element);
  return {
    term: {
      element,
      getSelection: () => selection,
      attachCustomKeyEventHandler: vi.fn(),
    } as unknown as Terminal,
    element,
    textarea,
  };
}

async function fire(name: string) {
  handlers.get(name)?.();
  // The handlers are async internally; let their promises settle.
  await Promise.resolve();
  await Promise.resolve();
}

describe("terminal clipboard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    copyText.mockClear();
    pasteText.mockClear();
    pasteText.mockResolvedValue("");
    usePortaStore.getState().setTerminalCopyOnSelect(true);
  });

  it("copies the selection when the drag ends", () => {
    const { term, element } = fakeTerm("npm run dev");
    registerTerminalPane(term, () => {});
    element.dispatchEvent(new MouseEvent("mouseup"));
    expect(copyText).toHaveBeenCalledWith("npm run dev");
  });

  it("leaves the clipboard alone when copy-on-select is off", () => {
    usePortaStore.getState().setTerminalCopyOnSelect(false);
    const { term, element } = fakeTerm("npm run dev");
    registerTerminalPane(term, () => {});
    element.dispatchEvent(new MouseEvent("mouseup"));
    expect(copyText).not.toHaveBeenCalled();
  });

  it("stops copying on select once the pane is disposed", () => {
    const { term, element } = fakeTerm("npm run dev");
    registerTerminalPane(term, () => {})();
    element.dispatchEvent(new MouseEvent("mouseup"));
    expect(copyText).not.toHaveBeenCalled();
  });

  it("routes the Edit menu's Copy to the focused pane, not the DOM selection", async () => {
    const { term, textarea } = fakeTerm("ready in 412 ms");
    registerTerminalPane(term, () => {});
    installClipboardMenuBridge();
    textarea.focus();
    await fire("menu://edit-copy");
    expect(copyText).toHaveBeenCalledWith("ready in 412 ms");
  });

  it("pastes into the pane's PTY rather than the hidden textarea", async () => {
    pasteText.mockResolvedValue("echo hi");
    const write = vi.fn();
    const { term, textarea } = fakeTerm("");
    registerTerminalPane(term, write);
    installClipboardMenuBridge();
    textarea.focus();
    await fire("menu://edit-paste");
    expect(write).toHaveBeenCalledWith("echo hi");
  });

  it("falls back to the focused input when no terminal has focus", async () => {
    const input = document.createElement("input");
    input.value = "porta.test";
    document.body.appendChild(input);
    installClipboardMenuBridge();
    input.focus();
    input.setSelectionRange(0, 5);
    await fire("menu://edit-copy");
    expect(copyText).toHaveBeenCalledWith("porta");
  });
});
