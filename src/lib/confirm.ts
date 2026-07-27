// Native confirm dialogs. `window.confirm` is unreliable inside the Tauri
// WebView (it can resolve immediately, or not render at all), so every
// destructive prompt goes through the dialog plugin instead.

interface ConfirmOptions {
  title?: string;
  okLabel?: string;
  kind?: "info" | "warning" | "error";
}

/**
 * Ask the user to confirm, via the OS dialog.
 *
 * Every destructive prompt in the app should route through here rather than
 * calling `window.confirm` — in the WKWebView that can return without ever
 * painting a dialog, which turns "are you sure?" into a silent yes. The plain
 * `window.confirm` fallback only kicks in outside Tauri (vitest / `npm run
 * dev` in a browser), where it behaves normally.
 */
export async function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const { title = "Confirm", okLabel, kind = "warning" } = opts;
  try {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return await confirm(message, { title, kind, ...(okLabel ? { okLabel } : {}) });
  } catch {
    return window.confirm(message);
  }
}

/**
 * Confirm removing a worktree instance. Removal stops the process, frees the
 * port and drops the Caddy route — the git worktree itself stays on disk, so
 * say that rather than letting the user assume their branch checkout is gone.
 */
export async function confirmRemoveInstance(branch: string): Promise<boolean> {
  return confirmDialog(
    `Remove the instance for "${branch}"? Its process is stopped and its domain stops resolving. The git worktree on disk is left alone.`,
    { title: "Remove instance", okLabel: "Remove" },
  );
}

/**
 * Confirm restoring a database snapshot. This replaces everything — apps,
 * workspaces, settings — with the state at snapshot time.
 */
export async function confirmRestoreBackup(label: string): Promise<boolean> {
  return confirmDialog(
    `Restore the snapshot from ${label}?\n\nEvery workspace, app and setting is replaced with its state at that moment. Porta snapshots where you are right now first, so this is undoable.`,
    { title: "Restore backup", okLabel: "Restore" },
  );
}
