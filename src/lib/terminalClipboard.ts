import type { Terminal } from "@xterm/xterm";
import { listen } from "@tauri-apps/api/event";
import { copyText, pasteText } from "./clipboard";
import { usePortaStore } from "../store";

/**
 * Clipboard routing for ⌘X / ⌘C / ⌘V.
 *
 * Those chords belong to the native Edit menu (src-tauri/src/menu.rs), so macOS
 * consumes them before the webview ever sees a keydown — which is why the
 * terminal could never copy: the native `copy:` action only understands DOM
 * selections, and xterm draws its selection on a canvas. The menu items now
 * emit `menu://edit-*` instead, and this module decides what the keystroke
 * means for whatever currently has focus.
 */

interface Pane {
  term: Terminal;
  write: (data: string) => void;
}

const panes = new Set<Pane>();

/**
 * Registers an xterm pane so the Edit menu can reach it, and wires the
 * Ctrl+Shift+C/V chords that the menu does not own. `write` should send the
 * pasted bytes to whatever PTY backs the pane.
 */
export function registerTerminalPane(term: Terminal, write: (data: string) => void): () => void {
  const pane: Pane = { term, write };
  panes.add(pane);

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || !event.ctrlKey || !event.shiftKey) return true;
    const key = event.key.toLowerCase();
    if (key === "c") {
      const selection = term.getSelection();
      if (!selection) return true; // nothing selected — let the shell have it
      void copyText(selection);
      event.preventDefault();
      return false;
    }
    if (key === "v") {
      void pasteText().then((text) => { if (text) write(text); });
      event.preventDefault();
      return false;
    }
    return true;
  });

  // Copy-on-select, the way a log viewer behaves: the selection lands on the
  // clipboard as soon as the drag (or the double/triple-click) ends, so the
  // common case never needs a second keystroke. Bound to mouseup rather than
  // xterm's `onSelectionChange` because that fires on every pixel of the drag,
  // which would rewrite the clipboard hundreds of times per selection.
  const element = term.element;
  const onMouseUp = () => {
    if (!usePortaStore.getState().terminalCopyOnSelect) return;
    const selection = term.getSelection();
    if (selection) void copyText(selection);
  };
  element?.addEventListener("mouseup", onMouseUp);

  return () => {
    element?.removeEventListener("mouseup", onMouseUp);
    panes.delete(pane);
  };
}

/** The pane holding keyboard focus, if the focus is in a terminal at all. */
function focusedPane(): Pane | null {
  const active = document.activeElement;
  if (!active) return null;
  for (const pane of panes) {
    if (pane.term.element?.contains(active)) return pane;
  }
  return null;
}

function selectedText(): string {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const { selectionStart, selectionEnd, value } = active;
    if (selectionStart === null || selectionEnd === null) return "";
    return value.slice(selectionStart, selectionEnd);
  }
  return window.getSelection()?.toString() ?? "";
}

/**
 * Text goes in through `insertText` rather than by assigning `.value`: it is a
 * real editing command, so React-controlled inputs get their native `input`
 * event and CodeMirror sees the change through its own DOM observer.
 */
function insertIntoFocused(text: string) {
  document.execCommand("insertText", false, text);
}

async function handleCopy(cut: boolean) {
  const pane = focusedPane();
  if (pane) {
    const selection = pane.term.getSelection();
    if (selection) await copyText(selection);
    return; // a terminal's scrollback is not editable — nothing to cut
  }
  const text = selectedText();
  if (!text) return;
  await copyText(text);
  // `delete` rather than inserting an empty string — WebKit treats a zero
  // length insertText as a no-op.
  if (cut) document.execCommand("delete");
}

async function handlePaste() {
  const text = await pasteText();
  if (!text) return;
  const pane = focusedPane();
  if (pane) {
    pane.write(text);
    return;
  }
  insertIntoFocused(text);
}

/** Installs the Edit-menu listeners. Call once, from the app root. */
export function installClipboardMenuBridge(): () => void {
  const unlisten = [
    listen("menu://edit-copy", () => { void handleCopy(false); }),
    listen("menu://edit-cut", () => { void handleCopy(true); }),
    listen("menu://edit-paste", () => { void handlePaste(); }),
  ];
  return () => { unlisten.forEach((p) => void p.then((un) => un())); };
}
