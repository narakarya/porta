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

/**
 * Format a byte count using IEC units (kB / MB / GB / TB). Tuned for the disk
 * usage panel — keeps one decimal up through GB, drops it for sub-1 kB values.
 */
export function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}
