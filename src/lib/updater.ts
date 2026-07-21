import type { Update } from "@tauri-apps/plugin-updater";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { usePortaStore } from "../store";
import type { UpdaterPhase } from "../store/slices/ui";
import * as cmd from "./commands";

// The updater plugin calls into the native runtime; in a plain browser (Vite
// dev / design review) those `invoke` calls throw "Cannot read properties of
// undefined (reading 'invoke')". Guard every entry point so the browser never
// hits a native call — the toast can still be previewed via a mocked phase.
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
// Only used by the STABLE channel (the JS plugin path). On the beta channel
// there is no JS Update object — the download runs through Rust — so this
// stays null and `pendingIsBeta` routes the download instead.
let cachedUpdate: Update | null = null;

// Which channel produced the currently-surfaced `available` update, so
// `startUpdateDownload` knows whether to use the JS Update object (stable) or
// the Rust `install_update_channel` command (beta). Set on every check.
let pendingIsBeta = false;

// Coalesces concurrent check calls — second caller awaits the same Promise.
let activeCheck: Promise<void> | null = null;

// Native updater checks can hang on network/release-metadata failures. Keep a
// generation token so a timed-out or dismissed check cannot update the UI later
// if the underlying plugin promise eventually resolves.
let checkGeneration = 0;
const UPDATE_CHECK_TIMEOUT_MS = 20_000;

// Guard against double-clicking "Download" while a download is already in
// flight. Cleared on completion (ready/error).
let downloadInFlight = false;

function setPhase(phase: UpdaterPhase, patch: Record<string, unknown> = {}) {
  usePortaStore.setState({ updaterPhase: phase, ...patch });
}

/**
 * Does a failed CHECK mean "there is nothing to fetch right now" rather than
 * "something is broken"?
 *
 * The beta channel republishes `latest.json` on the fixed `beta` release for
 * every build, so a check that lands mid-publish reads a manifest that isn't
 * there yet; being offline looks the same from here. Neither is a malfunction
 * the user can act on, and surfacing the plugin's own wording ("Could not
 * fetch a valid release JSON from the remote") as a red *Update failed* reads
 * like the app broke. Those get the neutral `unavailable` phase instead.
 *
 * Anything else — a manifest that parsed but is malformed, a signature
 * mismatch, an unexpected plugin fault — is a real error and stays red.
 * Download/install failures never come through here.
 */
export function isManifestUnreachable(message: string): boolean {
  const m = message.toLowerCase();
  return [
    "could not fetch a valid release json",
    // Bare "not found" would also swallow "the platform darwin-aarch64 was not
    // found on the response" — a manifest that WAS fetched and is genuinely
    // wrong. Match the HTTP status instead.
    "404",
    "timed out",
    "dns error",
    "error sending request",
    "failed to lookup address",
    "connection refused",
    "network",
    "offline",
  ].some((needle) => m.includes(needle));
}

// Route a failed manual check to the phase that matches what actually went
// wrong. The raw message is deliberately dropped for `unavailable` — there is
// nothing in it a user could act on, and the toast says it better.
function setCheckFailurePhase(message: string) {
  if (isManifestUnreachable(message)) {
    setPhase("unavailable", { updaterError: null, updaterInfo: null });
  } else {
    setPhase("error", { updaterError: message, updaterInfo: null });
  }
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
export function checkForUpdate(
  opts: { silent?: boolean; source?: "popover" | "menu" | "background" } = {},
): Promise<void> {
  if (!isTauri) return Promise.resolve();
  if (activeCheck) return activeCheck;
  usePortaStore.setState({ updaterCheckSource: opts.source ?? "menu" });
  const generation = ++checkGeneration;
  const promise = runUpdateCheck(opts, generation).finally(() => {
    if (activeCheck === promise) activeCheck = null;
  });
  activeCheck = promise;
  return promise;
}

// Throttle for background auto-checks (startup / interval / window-focus) so
// returning to the window repeatedly doesn't hammer the release server. Manual
// checks from the menu bypass this entirely.
let lastAutoCheckAt = 0;
const AUTO_CHECK_MIN_GAP_MS = 30 * 60 * 1000; // 30m

/**
 * Silent, throttled update check for background triggers. Safe to call often
 * (on every window focus) — it no-ops if the last auto-check was under 30m ago.
 * Surfaces an update only via the existing toast; says nothing when current.
 */
export function autoCheckForUpdate(): void {
  const now = Date.now();
  if (now - lastAutoCheckAt < AUTO_CHECK_MIN_GAP_MS) return;
  lastAutoCheckAt = now;
  void checkForUpdate({ silent: true, source: "background" });
}

function isCurrentCheck(generation: number): boolean {
  return generation === checkGeneration;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error("Update check timed out")), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

async function runUpdateCheck(
  { silent = true }: { silent?: boolean },
  generation: number,
): Promise<void> {
  const phase = usePortaStore.getState().updaterPhase;

  // If we already have a downloaded update, surface that — no point asking
  // the server again until the user restarts to consume it.
  if (phase === "ready") return;

  // If a download / install / restart is happening right now, leave it alone.
  if (phase === "downloading" || phase === "installing" || phase === "restarting") return;

  setPhase("checking", { updaterError: null });

  // Beta channel: the JS plugin's `check()` can only read the stable endpoint
  // baked into tauri.conf.json, so route the version check through Rust with
  // the beta endpoint. Stable stays on the untouched JS path below.
  if (usePortaStore.getState().betaUpdates) {
    let meta: cmd.UpdateMeta | null;
    try {
      meta = await withTimeout(cmd.checkUpdateChannel(true), UPDATE_CHECK_TIMEOUT_MS);
    } catch (e) {
      if (!isCurrentCheck(generation)) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Background (silent) checks must never interrupt with a blocking "Update
      // failed" toast — a transient release gap (beta tag mid-publish), an
      // offline window, or an endpoint hiccup all land here. Stay quiet and let
      // the next auto-check retry. Only a user-initiated check surfaces errors.
      if (silent) {
        setPhase("idle", { updaterError: null, updaterInfo: null });
        return;
      }
      setCheckFailurePhase(msg);
      return;
    }

    if (!isCurrentCheck(generation)) return;

    if (!meta) {
      if (silent) {
        setPhase("idle", { updaterInfo: null, updaterError: null });
      } else {
        setPhase("uptodate", { updaterInfo: null, updaterError: null });
        window.setTimeout(() => {
          if (usePortaStore.getState().updaterPhase === "uptodate") setPhase("idle");
        }, 3200);
      }
      return;
    }

    cachedUpdate = null;
    pendingIsBeta = true;
    setPhase("available", {
      updaterInfo: {
        version: meta.version,
        currentVersion: meta.currentVersion,
        body: meta.body,
        total: 0,
        downloaded: 0,
      },
    });
    return;
  }

  let upd: Update | null;
  try {
    upd = await withTimeout(check(), UPDATE_CHECK_TIMEOUT_MS);
  } catch (e) {
    if (!isCurrentCheck(generation)) return;
    const msg = e instanceof Error ? e.message : String(e);
    // Background (silent) checks stay quiet on any failure — offline, timeout,
    // or a transient "valid release JSON" fetch error shouldn't pop a blocking
    // toast the user never asked for. The next auto-check retries.
    if (silent) {
      setPhase("idle", { updaterError: null, updaterInfo: null });
      return;
    }
    // Manual checks surface the failure in the toast with Retry/Dismiss — no
    // blocking native dialog.
    setCheckFailurePhase(msg);
    return;
  }

  if (!isCurrentCheck(generation)) return;

  if (!upd) {
    if (silent) {
      setPhase("idle", { updaterInfo: null, updaterError: null });
    } else {
      // Manual check: confirm "up to date" with a brief, self-dismissing toast
      // instead of a blocking alert.
      setPhase("uptodate", { updaterInfo: null, updaterError: null });
      window.setTimeout(() => {
        if (usePortaStore.getState().updaterPhase === "uptodate") {
          setPhase("idle");
        }
      }, 3200);
    }
    return;
  }

  cachedUpdate = upd;
  pendingIsBeta = false;
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
  // Beta channel downloads run through Rust (no JS Update object exists).
  if (pendingIsBeta) return startBetaDownload();
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
 * Beta-channel download + install. The binary is fetched/swapped by the Rust
 * `install_update_channel` command; progress arrives via `updater://*` events
 * which we pump into the same `updaterInfo` shape the stable path uses, so the
 * toast/Settings progress bar renders identically.
 */
async function startBetaDownload(): Promise<void> {
  const info = usePortaStore.getState().updaterInfo;
  if (!info) return;

  downloadInFlight = true;
  setPhase("downloading", { updaterInfo: { ...info, total: 0, downloaded: 0 } });

  const { listen } = await import("@tauri-apps/api/event");
  const unlisten: Array<() => void> = [];

  try {
    unlisten.push(
      await listen<{ contentLength: number | null }>("updater://started", (e) => {
        const cur = usePortaStore.getState().updaterInfo;
        if (!cur) return;
        usePortaStore.setState({
          updaterInfo: { ...cur, total: e.payload.contentLength ?? 0, downloaded: 0 },
        });
      }),
    );
    unlisten.push(
      await listen<{ chunkLength: number }>("updater://progress", (e) => {
        const cur = usePortaStore.getState().updaterInfo;
        if (!cur) return;
        usePortaStore.setState({
          updaterInfo: { ...cur, downloaded: cur.downloaded + (e.payload.chunkLength ?? 0) },
        });
      }),
    );
    unlisten.push(
      await listen("updater://finished", () => {
        // Download done; Rust is swapping the .app on disk. Mirror the stable
        // path's `installing` beat before we reach `ready` below.
        setPhase("installing");
      }),
    );

    await cmd.installUpdateChannel(true);
    setPhase("ready");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setPhase("error", { updaterError: msg });
    // Allow a retry; a fresh check re-populates the available update.
    downloadInFlight = false;
  } finally {
    unlisten.forEach((u) => u());
  }
}

/**
 * Relaunch the app to consume the freshly installed binary. Only valid in
 * the `ready` phase — otherwise a no-op so a stray click can't restart the
 * app mid-download.
 */
export async function restartForUpdate(): Promise<void> {
  if (!isTauri) return;
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
  if (phase === "checking") {
    checkGeneration++;
    activeCheck = null;
    setPhase("idle", { updaterError: null, updaterInfo: null });
  } else if (phase === "available" || phase === "error" || phase === "unavailable") {
    setPhase("idle", { updaterError: null });
  }
}
