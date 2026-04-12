import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { usePortaStore } from "./store";

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
