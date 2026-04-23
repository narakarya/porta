/**
 * Yield two animation frames before proceeding.
 *
 * In WebKit (Tauri/Mac), a single rAF fires *before* the browser has finished
 * painting. The second rAF fires after layout + paint, so the spinner (or any
 * DOM change from a setState call before this) is guaranteed to be visible on
 * screen by the time the awaited operation starts.
 */
export function yieldToFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
