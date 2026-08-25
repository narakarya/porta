/**
 * Clipboard access for the terminal panes.
 *
 * `navigator.clipboard` is unavailable inside the macOS WKWebView Tauri serves
 * the app from (`tauri://localhost` is not a secure context), so the plugin is
 * the only reliable path in the packaged app. The web fallbacks exist for mock
 * mode in the browser at `localhost:1420`.
 */
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isTauri } from "./commands";

export async function copyText(text: string): Promise<void> {
  if (!text) return;
  if (isTauri) {
    await writeText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Last resort for browsers without the async clipboard API. Needs a live
  // user gesture, which every caller here has (a keydown or a click).
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.appendChild(scratch);
  scratch.select();
  try {
    document.execCommand("copy");
  } finally {
    scratch.remove();
  }
}

export async function pasteText(): Promise<string> {
  if (isTauri) return (await readText()) ?? "";
  if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  return "";
}
