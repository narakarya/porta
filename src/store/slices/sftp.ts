import type { StateCreator } from "zustand";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";
import type { SftpEntry, SftpFileContent, SftpListing } from "../../lib/commands";

/** Browser state for one SSH session's remote filesystem.
 *
 *  Kept per session and separate from `SshSession` on purpose: the PTY has its
 *  own working directory that Porta cannot observe, so conflating the two would
 *  mean showing a path that silently disagrees with the shell next to it. */
export interface SftpPane {
  cwd: string;
  listing: SftpListing | null;
  loading: boolean;
  error: string | null;
  /** Bumped per navigation; a resolution with a stale seq is discarded. */
  navSeq: number;
  /** Recently-seen listings by absolute path, so walking back up a tree is
   *  instant instead of another round trip. */
  cache: Record<string, { listing: SftpListing; at: number }>;
}

/** How long a cached directory stays usable.
 *
 *  Short: a remote directory is someone else's to change, and a listing that
 *  outlives the user's sense of "I just looked" would show files that are gone.
 *  Long enough that clicking into a folder and back is free. */
const LISTING_TTL_MS = 30_000;

export interface SftpOpenFile extends SftpFileContent {
  /** Editor buffer — diverges from `content` while there are unsaved edits. */
  draft: string;
  saving: boolean;
  error: string | null;
  /** Someone else changed the file since it was read; nothing was written. */
  conflict: boolean;
}

const emptyPane = (): SftpPane => ({
  cwd: "",
  listing: null,
  loading: false,
  error: null,
  navSeq: 0,
  cache: {},
});

export interface SftpSlice {
  sftpPanes: Record<string, SftpPane>;
  /** At most one open file per session. */
  sftpOpen: Record<string, SftpOpenFile>;

  /** Resolve the session's home directory and list it. Safe to call repeatedly. */
  sftpInit: (sessionId: string) => Promise<void>;
  sftpNavigate: (sessionId: string, path: string) => Promise<void>;
  sftpRefresh: (sessionId: string) => Promise<void>;
  sftpOpenFile: (sessionId: string, entry: SftpEntry) => Promise<void>;
  sftpEditDraft: (sessionId: string, draft: string) => void;
  sftpSaveFile: (sessionId: string) => Promise<void>;
  sftpCloseFile: (sessionId: string) => void;
  /** Drop a dead session's browse state. Returns the path of an open file that
   *  still had unsaved edits, so the caller can say so out loud. */
  sftpForgetSession: (sessionId: string) => string | null;
}

export const createSftpSlice: StateCreator<AllSlices, [], [], SftpSlice> = (set, get) => {
  const pane = (id: string) => get().sftpPanes[id] ?? emptyPane();
  const setPane = (id: string, patch: Partial<SftpPane>) =>
    set({ sftpPanes: { ...get().sftpPanes, [id]: { ...pane(id), ...patch } } });

  async function load(sessionId: string, path: string, force = false) {
    // Capture the sequence before the await. Clicking through directories
    // faster than the server answers would otherwise let an earlier listing
    // land last and overwrite the directory the user is actually looking at.
    const seq = pane(sessionId).navSeq + 1;

    const hit = pane(sessionId).cache[path];
    if (!force && hit && Date.now() - hit.at < LISTING_TTL_MS) {
      // Paint from cache and stop — no spinner, no round trip.
      setPane(sessionId, {
        navSeq: seq,
        loading: false,
        error: null,
        cwd: hit.listing.path,
        listing: hit.listing,
      });
      return;
    }

    setPane(sessionId, { navSeq: seq, loading: true, error: null, cwd: path });
    try {
      const listing = await cmd.sftpList(sessionId, path);
      if (pane(sessionId).navSeq !== seq) return;
      setPane(sessionId, {
        listing,
        cwd: listing.path,
        loading: false,
        // Key on the RESOLVED path: the caller may have passed `.` or a
        // symlink, and caching under that would never be hit again.
        cache: { ...pane(sessionId).cache, [listing.path]: { listing, at: Date.now() } },
      });
    } catch (e) {
      if (pane(sessionId).navSeq !== seq) return;
      setPane(sessionId, {
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    sftpPanes: {},
    sftpOpen: {},

    sftpInit: async (sessionId) => {
      const existing = get().sftpPanes[sessionId];
      if (existing?.listing || existing?.loading) return;
      setPane(sessionId, { loading: true, error: null });
      try {
        const home = await cmd.sftpHome(sessionId);
        await load(sessionId, home);
      } catch (e) {
        setPane(sessionId, {
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },

    sftpNavigate: async (sessionId, path) => load(sessionId, path),
    sftpRefresh: async (sessionId) => {
      // Refresh means the user wants the truth, so it goes past the cache.
      const cwd = pane(sessionId).cwd;
      if (cwd) await load(sessionId, cwd, true);
    },

    sftpOpenFile: async (sessionId, entry) => {
      if (entry.lossyName) {
        throw new Error(
          "This name didn't survive the server's character decoding, so Porta can't address " +
            "the file. Use the terminal for it."
        );
      }
      const file = await cmd.sftpRead(sessionId, entry.path);
      set({
        sftpOpen: {
          ...get().sftpOpen,
          [sessionId]: { ...file, draft: file.content, saving: false, error: null, conflict: false },
        },
      });
    },

    sftpEditDraft: (sessionId, draft) => {
      const open = get().sftpOpen[sessionId];
      if (!open) return;
      // Typing clears a previous conflict banner: the user has seen it, and
      // leaving it up would imply the next save is still blocked.
      set({ sftpOpen: { ...get().sftpOpen, [sessionId]: { ...open, draft, conflict: false } } });
    },

    sftpSaveFile: async (sessionId) => {
      const open = get().sftpOpen[sessionId];
      if (!open) return;
      // These used to live only on the Save button, so ⌘S went straight past
      // them. A binary file is held with an EMPTY draft (the editor refuses to
      // decode it), which meant one keystroke could overwrite a remote binary
      // with nothing at all.
      if (open.binary || open.saving || open.draft === open.content) return;
      const patch = (p: Partial<SftpOpenFile>) => {
        const cur = get().sftpOpen[sessionId];
        if (!cur) return;
        set({ sftpOpen: { ...get().sftpOpen, [sessionId]: { ...cur, ...p } } });
      };
      patch({ saving: true, error: null, conflict: false });
      try {
        const outcome = await cmd.sftpSave(sessionId, open.path, open.draft, open.mtime);
        if (outcome.status === "conflict") {
          // Nothing was written. Keep the draft — it is the user's only copy of
          // their edits, and discarding it to show the remote version would
          // throw away exactly what they came to save.
          patch({ saving: false, conflict: true });
          return;
        }
        patch({ saving: false, content: open.draft, mtime: outcome.mtime });
        // The directory holding this file now has a different mtime and size,
        // so its cached listing is a lie. Drop it rather than let Files show
        // stale numbers for a file the user just saved.
        const dir = open.path.replace(/\/[^/]+$/, "") || "/";
        const cache = { ...pane(sessionId).cache };
        delete cache[dir];
        setPane(sessionId, { cache });
      } catch (e) {
        patch({ saving: false, error: e instanceof Error ? e.message : String(e) });
      }
    },

    sftpCloseFile: (sessionId) => {
      const next = { ...get().sftpOpen };
      delete next[sessionId];
      set({ sftpOpen: next });
    },

    sftpForgetSession: (sessionId) => {
      const open = get().sftpOpen[sessionId];
      // The draft is genuinely gone — the channel it would have been written
      // through died with the session. Report the loss rather than letting the
      // pane quietly disappear with the work in it.
      const lost = open && open.draft !== open.content ? open.path : null;
      const panes = { ...get().sftpPanes };
      const files = { ...get().sftpOpen };
      delete panes[sessionId];
      delete files[sessionId];
      set({ sftpPanes: panes, sftpOpen: files });
      return lost;
    },
  };
};
