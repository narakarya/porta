import type { StateCreator } from "zustand";
import type { AllSlices } from "../index";

export type NoticeKind = "success" | "error" | "info";

export interface Notice {
  id: string;
  kind: NoticeKind;
  /** One-line headline. */
  message: string;
  /** Optional detail — a backend error string, a stack, a path. Monospaced. */
  detail?: string | null;
  /** ms until auto-dismiss; null keeps it until the user closes it. */
  timeout: number | null;
}

export interface NotifySlice {
  notices: Notice[];
  /** Push a notice. Returns its id so callers can dismiss it early. */
  notify: (n: Omit<Notice, "id" | "timeout"> & { timeout?: number | null }) => string;
  /** Convenience: report a caught error with a headline. */
  notifyError: (message: string, error: unknown) => string;
  dismissNotice: (id: string) => void;
}

let _seq = 0;

/** Errors stay until dismissed; successes fade. */
const DEFAULT_TIMEOUT: Record<NoticeKind, number | null> = {
  success: 2600,
  info: 4000,
  error: null,
};

/** Backend errors can be whole compose logs — keep the toast readable. */
const MAX_DETAIL = 600;

export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.length > MAX_DETAIL ? `${raw.slice(0, MAX_DETAIL)}…` : raw;
}

/**
 * App-wide notice queue. Exists so failures have somewhere to go that is not a
 * blocking `window.alert` and not a silent `catch {}` — both of which this app
 * used in place of an actual error surface.
 *
 * Mounted once at the App root (see `<Notices />`), NOT inside WorkspaceView:
 * that subtree is `hidden` whenever the workbench is open, which is exactly how
 * the previous save-confirmation toast ended up unreachable.
 */
export const createNotifySlice: StateCreator<AllSlices, [], [], NotifySlice> = (set, get) => ({
  notices: [],

  notify: ({ kind, message, detail = null, timeout }) => {
    const id = `notice-${++_seq}`;
    set((s) => ({
      notices: [...s.notices, { id, kind, message, detail, timeout: timeout ?? DEFAULT_TIMEOUT[kind] }],
    }));
    return id;
  },

  notifyError: (message, error) =>
    get().notify({ kind: "error", message, detail: errorText(error) }),

  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
});
