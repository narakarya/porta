// Native confirm dialogs. `window.confirm` is unreliable inside the Tauri
// WebView (it can resolve immediately, or not render at all), so every
// destructive prompt goes through the dialog plugin instead.

/**
 * Confirm removing a worktree instance. Removal stops the process, frees the
 * port and drops the Caddy route — the git worktree itself stays on disk, so
 * say that rather than letting the user assume their branch checkout is gone.
 */
export async function confirmRemoveInstance(branch: string): Promise<boolean> {
  const { confirm } = await import("@tauri-apps/plugin-dialog");
  return confirm(
    `Remove the instance for "${branch}"? Its process is stopped and its domain stops resolving. The git worktree on disk is left alone.`,
    { title: "Remove instance", kind: "warning", okLabel: "Remove" },
  );
}
