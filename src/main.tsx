import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { usePortaStore } from "./store";

// Global error handler — helps debug blank screen in Tauri
window.addEventListener("error", (e) => {
  const pre = document.createElement("pre");
  pre.style.cssText = "color:red;padding:20px;font-size:12px;";
  pre.textContent = `UNCAUGHT ERROR:\n${e.message}\n${e.filename}:${e.lineno}`;
  document.body.appendChild(pre);
});
window.addEventListener("unhandledrejection", (e) => {
  const pre = document.createElement("pre");
  pre.style.cssText = "color:orange;padding:20px;font-size:12px;";
  pre.textContent = `UNHANDLED REJECTION:\n${e.reason}`;
  document.body.appendChild(pre);
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
