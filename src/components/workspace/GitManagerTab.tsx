import { useEffect, useRef } from "react";
import { extensionShellRun } from "../../lib/commands";
import type { App } from "../../types";
import { GIT_MANAGER_MARKUP } from "../../vendor/git-manager/markup";
import "../../vendor/git-manager/style.css";

/**
 * The porta-git-manager UI running **in-process**, inside Porta's own window,
 * instead of inside an extension iframe.
 *
 * The vendored code is the extension's own vanilla JS, patched only for scoping
 * (see `scripts/vendor-git-manager.mjs`). Everything it needs from a host is
 * four things — `shell.run`, `ui.setTitle`, `app.rootDir`, `app.name` — which
 * this component supplies as `window.portaBridge`.
 *
 * Why in-process rather than the iframe: the panel is kept mounted, so scroll
 * position, filters and a half-typed commit message survive a tab switch; there
 * is no iframe boot on every visit; and a ported-to-React tab can later take
 * over one `<section data-pane>` at a time without disturbing the rest.
 */

/** Mutable — the vendored IIFE captures this object once and reads through it. */
interface GitManagerBridge {
  app: { name: string; rootDir: string };
  ui: { setTitle: (title: string) => void };
  shell: { run: (cmd: string, opts?: { cwd?: string; timeout?: number }) => Promise<unknown> };
}

declare global {
  interface Window {
    portaBridge?: GitManagerBridge;
    __GM_ROOT?: HTMLElement;
    __GM_INIT?: () => void | Promise<void>;
  }
}

/** The vendored scripts are side-effecting IIFEs and must evaluate exactly once,
 *  and only after the bridge exists — app.js captures it at evaluation time and
 *  bails out for good if it is missing. Hence the dynamic import. */
let scriptsLoaded: Promise<void> | null = null;

function loadVendoredScripts(): Promise<void> {
  if (!scriptsLoaded) {
    scriptsLoaded = (async () => {
      // Load order matters — it mirrors the extension's index.html.
      await import("../../vendor/git-manager/text-util.js");
      await import("../../vendor/git-manager/diff-util.js");
      await import("../../vendor/git-manager/highlight.js");
      await import("../../vendor/git-manager/md-util.js");
      await import("../../vendor/git-manager/file-tree.js");
      await import("../../vendor/git-manager/status-util.js");
      await import("../../vendor/git-manager/git-util.js");
      await import("../../vendor/git-manager/dom-util.js");
      await import("../../vendor/git-manager/app.js");
    })();
  }
  return scriptsLoaded;
}

export default function GitManagerTab({ app }: { app: App }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;

    // SPIKE: routed through the extension's shell IPC, which still requires
    // `git-manager` to be installed and enabled. Shipping this needs a core
    // command with the same body minus the extension-permission check
    // (src-tauri/src/commands/extension_shell.rs:145).
    const bridge: GitManagerBridge = {
      app: { name: app.name, rootDir: app.root_dir },
      ui: { setTitle: () => {} },
      shell: {
        run: (cmd, opts) =>
          extensionShellRun(app.id, "git-manager", cmd, {
            cwdOverride: opts?.cwd,
            timeoutMs: opts?.timeout,
          }),
      },
    };

    window.portaBridge = bridge;
    window.__GM_ROOT = host;
    host.innerHTML = GIT_MANAGER_MARKUP;

    loadVendoredScripts().then(() => {
      if (cancelled) return;
      // Re-pointed on every mount: the module itself only ever evaluates once,
      // so switching apps re-runs init() against the new root and rootDir.
      window.__GM_ROOT = host;
      window.portaBridge = bridge;
      void window.__GM_INIT?.();
    });

    return () => {
      cancelled = true;
    };
  }, [app.id, app.name, app.root_dir]);

  // tabIndex makes the subtree focusable so the vendored keydown handlers —
  // rebound from `window` to this root — actually receive keys.
  return <div ref={hostRef} className="gm-root h-full overflow-hidden" tabIndex={-1} />;
}
