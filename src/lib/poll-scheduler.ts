import { useEffect, useRef } from "react";

/**
 * One timer for every recurring poll in the app.
 *
 * Porta had eight-plus independent `setInterval`s — host metrics every 2s,
 * tunnel metrics every 5s, WireGuard every 15s, health / Tailscale / image
 * digests every 30s, and so on — all of which kept firing while the window was
 * minimised behind someone's editor. For an app that sits open all day, that's
 * a steady drip of wakeups and network calls nobody is looking at.
 *
 * This module fixes three things at once:
 *
 * * **One timer.** A single tick drives every registered poll, so N polls cost
 *   one wakeup instead of N.
 * * **Hidden means paused.** Foreground polls stop while the window isn't
 *   visible and run once on the way back, so returning to Porta shows fresh
 *   data without having paid for the polls you never saw. When nothing is left
 *   to run, the tick itself stops.
 * * **No pile-ups.** An async poll slower than its own interval is skipped
 *   rather than stacked — the 5s tunnel poll against a slow Cloudflare API
 *   used to be able to overlap itself indefinitely.
 *
 * Polls that must keep running unattended — health checks (they drive the
 * app-down alerts), app-update checks, image-digest checks — opt out of the
 * pausing with `background: true`.
 */

const TICK_MS = 1000;

export interface PollOptions {
  /** Keep running while the window is hidden. Default `false`. */
  background?: boolean;
  /** Run once immediately on registration instead of waiting a full interval. */
  immediate?: boolean;
}

interface Task {
  fn: () => void | Promise<void>;
  intervalMs: number;
  background: boolean;
  nextDue: number;
  /** Guards against a slow async poll overlapping its next run. */
  running: boolean;
}

const tasks = new Set<Task>();
let tickHandle: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;

const now = () => Date.now();

const isHidden = () =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

/** Whether a task is eligible to run given the current visibility. */
const isActive = (t: Task) => t.background || !isHidden();

function runTask(t: Task) {
  // Schedule the next run from the moment this one *starts*, so a poll's
  // cadence doesn't drift by however long its own request takes.
  t.nextDue = now() + t.intervalMs;
  if (t.running) return;

  let result: void | Promise<void>;
  try {
    result = t.fn();
  } catch {
    return; // A throwing poll must not take the shared tick down with it.
  }
  if (result && typeof (result as Promise<void>).finally === "function") {
    t.running = true;
    (result as Promise<void>).finally(() => {
      t.running = false;
    });
  }
}

function tick() {
  const ts = now();
  for (const t of tasks) {
    if (isActive(t) && ts >= t.nextDue) runTask(t);
  }
  syncTimer();
}

/** Start the shared tick when something needs it, stop it when nothing does. */
function syncTimer() {
  const needed = [...tasks].some(isActive);
  if (needed && tickHandle === null) {
    tickHandle = setInterval(tick, TICK_MS);
  } else if (!needed && tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function onVisibilityChange() {
  if (!isHidden()) {
    // Back on screen: anything that came due while hidden runs once now — one
    // catch-up run, not one per interval missed.
    const ts = now();
    for (const t of tasks) {
      if (!t.background && ts >= t.nextDue) runTask(t);
    }
  }
  syncTimer();
}

function bindVisibility() {
  if (visibilityBound || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", onVisibilityChange);
  visibilityBound = true;
}

/**
 * Register a recurring poll. Returns an unsubscribe function — call it on
 * teardown exactly as you would `clearInterval`.
 */
export function registerPoll(
  fn: () => void | Promise<void>,
  intervalMs: number,
  opts: PollOptions = {}
): () => void {
  const { background = false, immediate = false } = opts;
  const task: Task = {
    fn,
    intervalMs: Math.max(TICK_MS, intervalMs),
    background,
    nextDue: now() + intervalMs,
    running: false,
  };
  tasks.add(task);
  bindVisibility();

  if (immediate && isActive(task)) runTask(task);
  syncTimer();

  return () => {
    tasks.delete(task);
    syncTimer();
  };
}

/**
 * React binding for {@link registerPoll}. `fn` is read through a ref, so an
 * inline closure won't restart the poll on every render — only a change to
 * `intervalMs` or the options does.
 */
export function usePoll(
  fn: () => void | Promise<void>,
  intervalMs: number,
  opts: PollOptions & { enabled?: boolean } = {}
): void {
  const { background = false, immediate = false, enabled = true } = opts;
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!enabled) return;
    return registerPoll(() => saved.current(), intervalMs, { background, immediate });
  }, [intervalMs, background, immediate, enabled]);
}

/** Test/debug hook: how many polls are currently registered. */
export const __pollCount = () => tasks.size;
