import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

// Disable native browser/webview context menu (shows inspect element in dev)
document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
