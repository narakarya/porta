import { useEffect } from "react";

/**
 * App-wide ⌘Z / ⌘⇧Z for plain text inputs and textareas.
 *
 * Why this exists rather than leaning on the webview: the native menu
 * deliberately omits Undo/Redo (see `src-tauri/src/menu.rs`) so ⌘Z falls
 * through to the webview for CodeMirror and the terminal, which keep their own
 * history. But WebKit's built-in undo doesn't survive React-controlled inputs,
 * so every ordinary field in the app — start command, ports, env values — was
 * left with no undo at all. This restores it in JS, where we control it.
 *
 * History is per-element and coalesced into bursts: a run of typing with no
 * pause longer than COALESCE_MS undoes as one step, which is what people expect
 * from a text field (undoing character-by-character is unusable).
 *
 * Elements that own their history are skipped, never fought with: CodeMirror
 * (`.cm-editor`), the terminal (`.xterm`), and anything contenteditable.
 */

const COALESCE_MS = 400;
const MAX_DEPTH = 100;

type Field = HTMLInputElement | HTMLTextAreaElement;

interface History {
  /** Past values, oldest first. Does NOT include the element's live value. */
  past: string[];
  /** Values undone away, most recently undone last. */
  future: string[];
  lastEditAt: number;
}

const histories = new WeakMap<Field, History>();

/** Input types where a text-undo stack makes sense. Password is excluded on
 *  purpose — restoring a credential the user just cleared is not a favour. */
const UNDOABLE_TYPES = new Set(["", "text", "search", "url", "tel", "email", "number"]);

function undoableField(target: EventTarget | null): Field | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target.isContentEditable) return null;
  // Editors with their own undo stack handle the keystroke themselves.
  if (target.closest(".cm-editor") || target.closest(".xterm")) return null;
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && UNDOABLE_TYPES.has(target.type)) return target;
  return null;
}

function historyFor(el: Field): History {
  let h = histories.get(el);
  if (!h) {
    h = { past: [], future: [], lastEditAt: 0 };
    histories.set(el, h);
  }
  return h;
}

/** Write a value into a React-controlled field. Assigning `.value` directly is
 *  invisible to React — it tracks the last value it rendered and would treat the
 *  next change as a no-op. Going through the prototype's setter and dispatching
 *  `input` is what makes React's onChange fire and state actually update. */
function setFieldValue(el: Field, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  // Park the caret at the end of the restored text; trying to preserve the
  // pre-undo caret offset is meaningless once the content changed underneath it.
  try {
    el.setSelectionRange(value.length, value.length);
  } catch {
    // Some input types (email, number) reject setSelectionRange — harmless.
  }
}

export function useTextFieldUndo() {
  useEffect(() => {
    // `beforeinput` fires while the field still holds its pre-edit value, which
    // is exactly the snapshot we want to keep.
    function onBeforeInput(e: Event) {
      const el = undoableField(e.target);
      if (!el) return;
      const h = historyFor(el);
      const now = Date.now();
      // A fresh burst of typing starts a new undo step; keystrokes inside a
      // burst fold into the step already recorded.
      if (now - h.lastEditAt > COALESCE_MS) {
        if (h.past[h.past.length - 1] !== el.value) {
          h.past.push(el.value);
          if (h.past.length > MAX_DEPTH) h.past.shift();
        }
        // Typing after an undo drops the redo trail, as in every editor.
        h.future.length = 0;
      }
      h.lastEditAt = now;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const el = undoableField(e.target);
      if (!el) return; // CodeMirror / terminal / contenteditable keep ⌘Z
      const h = histories.get(el);
      if (!h) return;

      const redo = e.shiftKey;
      const source = redo ? h.future : h.past;
      if (source.length === 0) {
        // Nothing of ours to restore — swallow it anyway, so the webview's own
        // (broken for controlled inputs) undo can't half-apply behind our back.
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const restored = source.pop() as string;
      (redo ? h.past : h.future).push(el.value);
      h.lastEditAt = 0; // the next keystroke starts a new burst
      setFieldValue(el, restored);
    }

    // Capture phase: get there before a field's own onKeyDown decides to act.
    window.addEventListener("beforeinput", onBeforeInput, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("beforeinput", onBeforeInput, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
}
