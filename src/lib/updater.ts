import type { Update } from "@tauri-apps/plugin-updater";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { message } from "@tauri-apps/plugin-dialog";

import { usePortaStore } from "../store";
import type { UpdaterPhase } from "../store/slices/ui";

/**
 * App updater driver. Owns the update lifecycle (check → download → install →
 * relaunch) and drives the UpdaterPhase state in the Zustand store so any
 * UI (the in-app toast, the Settings button) reflects the same phase.
 *
 * Invariants this module enforces:
 *   1. **No concurrent checks.** A second call while one is in flight returns
 *      the same Promise. (Fixes the race between auto-check on startup and
 *      the user clicking "Check for updates" — without this, both paths
 *      could open a separate native dialog with the same prompt.)
 *   2. **No re-download after a successful install.** Once phase is `ready`,
 *      `runUpdateCheck` short-circuits — the binary is already swapped on
 *      disk, all we need is `restartForUpdate()`.
 *   3. **Progress reaches the UI.** `downloadAndInstall` is called WITH an
 *      event callback that pumps `Started` / `Progress` / `Finished` into
 *      `updaterInfo` so the toast can render a real progress bar.
 */

// Set on first successful `check()` so we can call `downloadAndInstall` on it
// later when the user confirms. Cleared on error so a retry re-fetches.
let cachedUpdate: Update | null = null;

// Coalesces concurrent check calls — second caller awaits the same Promise.
let activeCheck: Promise<void> | null = null;

// Guard against double-clicking "Download" while a download is already in
// flight. Cleared on completion (ready/error).
let downloadInFlight = false;

function setPhase(phase: UpdaterPhase, patch: Record<string, unknown> = {}) {
  usePortaStore.setState({ updaterPhase: phase, ...patch });
}

/**
 * Kick off an update check. Idempotent — if a check is already running, the
 * caller receives the in-flight Promise. If we've already downloaded an
 * update (`ready` phase), this is a no-op (the toast already shows Restart).
 *
 * `silent` controls behaviour when there's no update:
 *   - `silent: true` (auto-check on startup) — phase resets to `idle` and
 *     no UI is shown.
 *   - `silent: false` (user clicked the button) — a small native dialog
 *     confirms "you're on the latest version" so the click isn't a no-op.
 */
export function checkForUpdate(opts: { silent?: boolean } = {}): Promise<void> {
  if (activeCheck) return activeCheck;
  activeCheck = runUpdateCheck(opts).finally(() => {
    activeCheck = null;
  });
  return activeCheck;
}

// Throttle for background auto-checks (startup / interval / window-focus) so
// returning to the window repeatedly doesn't hammer the release server. Manual
// checks from the menu bypass this entirely.
let lastAutoCheckAt = 0;
const AUTO_CHECK_MIN_GAP_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * Silent, throttled update check for background triggers. Safe to call often
 * (on every window focus) — it no-ops if the last auto-check was under 2h ago.
 * Surfaces an update only via the existing toast; says nothing when current.
 */
export function autoCheckForUpdate(): void {
  const now = Date.now();
  if (now - lastAutoCheckAt < AUTO_CHECK_MIN_GAP_MS) return;
  lastAutoCheckAt = now;
  void checkForUpdate({ silent: true });
}

async function runUpdateCheck({ silent = true }: { silent?: boolean }): Promise<void> {
  const phase = usePortaStore.getState().updaterPhase;

  // If we already have a downloaded update, surface that — no point asking
  // the server again until the user restarts to consume it.
  if (phase === "ready") return;

  // If a download / install / restart is happening right now, leave it alone.
  if (phase === "downloading" || phase === "installing" || phase === "restarting") return;

  setPhase("checking", { updaterError: null });

  let upd: Update | null;
  try {
    upd = await check();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setPhase("error", { updaterError: msg, updaterInfo: null });
    if (!silent) await message(`Could not check for updates:\n${msg}`, { title: "Porta", kind: "error" });
    return;
  }

  if (!upd) {
    setPhase("idle", { updaterInfo: null, updaterError: null });
    if (!silent) await message("You're on the latest version.", { title: "Porta" });
    return;
  }

  cachedUpdate = upd;
  setPhase("available", {
    updaterInfo: {
      version: upd.version,
      currentVersion: upd.currentVersion,
      body: upd.body ?? null,
      total: 0,
      downloaded: 0,
    },
  });
}

/**
 * Start the download + install for the cached update. Idempotent under
 * double-click; a no-op if no update is cached or a download already kicked
 * off this session.
 */
export async function startUpdateDownload(): Promise<void> {
  if (downloadInFlight) return;
  if (!cachedUpdate) return;
  const upd = cachedUpdate;
  const info = usePortaStore.getState().updaterInfo;
  if (!info) return;

  downloadInFlight = true;
  setPhase("downloading", { updaterInfo: { ...info, total: 0, downloaded: 0 } });

  try {
    await upd.downloadAndInstall((evt) => {
      const cur = usePortaStore.getState().updaterInfo;
      if (!cur) return;
      if (evt.event === "Started") {
        usePortaStore.setState({
          updaterInfo: {
            ...cur,
            total: evt.data.contentLength ?? 0,
            downloaded: 0,
          },
        });
      } else if (evt.event === "Progress") {
        usePortaStore.setState({
          updaterInfo: {
            ...cur,
            downloaded: cur.downloaded + (evt.data.chunkLength ?? 0),
          },
        });
      } else if (evt.event === "Finished") {
        // Download is done; tauri-bundler is now swapping the .app on disk.
        // Stays here a beat then transitions to `ready` below.
        setPhase("installing");
      }
    });
    setPhase("ready");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setPhase("error", { updaterError: msg });
    // Allow a retry; the cached Update object is still valid for another
    // downloadAndInstall attempt.
    downloadInFlight = false;
  }
}

/**
 * Relaunch the app to consume the freshly installed binary. Only valid in
 * the `ready` phase — otherwise a no-op so a stray click can't restart the
 * app mid-download.
 */
export async function restartForUpdate(): Promise<void> {
  if (usePortaStore.getState().updaterPhase !== "ready") return;
  setPhase("restarting");
  try {
    await relaunch();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setPhase("error", { updaterError: msg });
  }
}

/**
 * Close the toast without acting. Valid in `available` (user said "later")
 * and `error` (dismiss the failure). For `ready` we keep the toast around
 * so the user can still trigger restart — closing it would lose the only
 * affordance to actually consume the update they downloaded.
 */
export function dismissUpdater(): void {
  const phase = usePortaStore.getState().updaterPhase;
  if (phase === "available" || phase === "error") {
    setPhase("idle", { updaterError: null });
  }
}
