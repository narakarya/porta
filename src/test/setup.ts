import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Node 22+ exposes its own experimental `localStorage` global, which wins over
// jsdom's and is an inert `{}` unless `--localstorage-file` points somewhere
// real. `typeof localStorage !== "undefined"` therefore passes while every
// method is missing. Install a real in-memory Storage so the persistence paths
// behave the same here as in the WebView.
function memoryStorage(): Storage {
  let map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => void (map = new Map()),
  } as Storage;
}

const storage = memoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// The app branches on `isTauri` (presence of __TAURI_INTERNALS__) throughout.
// Tests run in jsdom with it absent, so every `lib/commands` wrapper takes its
// browser/mock path and no IPC is attempted.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

// jsdom implements neither, and xterm/the fit addon call both on mount.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
