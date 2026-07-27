import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * `listen`, but a no-op outside Tauri.
 *
 * The plain one reaches for `window.__TAURI_INTERNALS__.transformCallback`
 * *synchronously*, so calling it in a plain browser throws
 * "Cannot read properties of undefined (reading 'transformCallback')" — usually
 * as an unhandled rejection with no hint about which subscription did it. That
 * happens in `npm run dev` without the Tauri shell, in the design-preview
 * harness, and inside extension iframes, which don't get the IPC globals.
 *
 * Subscribing to an event that can never fire is harmless; crashing the
 * component that subscribed is not. Callers that already gate on `isTauri`
 * can keep using the raw import — this is for the ones that shouldn't have to.
 */
export function listen<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  if (!isTauri) return Promise.resolve(() => {});
  return tauriListen<T>(event, handler);
}

export type { UnlistenFn };
