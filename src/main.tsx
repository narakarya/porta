import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { usePortaStore } from "./store";

// Global error handler — helps debug blank screen in Tauri.
//
// Two guards, both learned from the log viewer flooding the window with red
// text: benign noise never reaches the overlay, and no single failure can
// repaint the same panel hundreds of times.
//
// `ResizeObserver loop completed with undelivered notifications` is a spec-
// mandated notice, not a fault: the observer had callbacks left over when the
// frame ended and will deliver them on the next one. virtua (the log viewer's
// virtualizer) measures every mounted row, so a fast stream trips it on
// basically every frame. The real pathological case has its own message
// ("loop limit exceeded"), which still gets through.
const BENIGN_ERROR_RE = /^(?:Uncaught )?(?:Error: )?ResizeObserver loop completed with undelivered notifications/;

// Repeats of an identical message add nothing and cost the whole viewport.
const seenErrors = new Set<string>();
const MAX_ERROR_PANELS = 8;

function showErrorPanel(kind: string, body: string, color: string) {
  if (seenErrors.has(body) || seenErrors.size >= MAX_ERROR_PANELS) return;
  seenErrors.add(body);
  const pre = document.createElement("pre");
  pre.style.cssText = `color:${color};padding:20px;font-size:12px;`;
  pre.textContent = `${kind}:\n${body}`;
  document.body.appendChild(pre);
}

window.addEventListener("error", (e) => {
  if (BENIGN_ERROR_RE.test(e.message)) return;
  showErrorPanel("UNCAUGHT ERROR", `${e.message}\n${e.filename}:${e.lineno}`, "red");
});
window.addEventListener("unhandledrejection", (e) => {
  showErrorPanel("UNHANDLED REJECTION", String(e.reason), "orange");
});

// Disable native browser/webview context menu (shows inspect element in dev)
document.addEventListener("contextmenu", (e) => e.preventDefault());

// Subscribe to app events once at module level — outside React lifecycle so
// StrictMode double-mount doesn't create duplicate Tauri event listeners.
usePortaStore.getState()._subscribeToAppEvents();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
