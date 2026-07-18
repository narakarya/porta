import { useState } from "react";
import type { ChangedFile } from "../../../lib/commands";
import { buildFileTree, type TreeNode } from "./file-tree";

// ── Inline icons (12–14px) — mirrors GitTab's local icon set; no icon-font
// dep, tokens-only colouring via currentColor. ──────────────────────────────
function ChevronRightIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" className={className} aria-hidden="true">
      <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function FolderIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2 4.2c0-.66.54-1.2 1.2-1.2h3.1l1.3 1.4h5.2c.66 0 1.2.54 1.2 1.2v6.2c0 .66-.54 1.2-1.2 1.2H3.2c-.66 0-1.2-.54-1.2-1.2V4.2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function PlusIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={className} aria-hidden="true">
      <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function MinusIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={className} aria-hidden="true">
      <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function TrashIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M5 4.5l.5 8c0 .4.3.7.7.7h3.6c.4 0 .7-.3.7-.7l.5-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// XY status badge — colour by section + git status char. (Mirrors GitTab's
// own copy; kept local so this file has no reach-back import into GitTab.)
function statusBadge(f: ChangedFile, staged: boolean): { char: string; cls: string } {
  if (staged) {
    const c = f.staged_status && f.staged_status !== "." ? f.staged_status : "M";
    return { char: c, cls: "text-ok" };
  }
  if (f.untracked) return { char: "?", cls: "text-accent" };
  const c = f.unstaged_status && f.unstaged_status !== "." ? f.unstaged_status : "M";
  if (c === "D") return { char: "D", cls: "text-bad" };
  if (c === "U") return { char: "U", cls: "text-accent" };
  return { char: c, cls: "text-warn" };
}

function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i >= 0 ? { dir: path.slice(0, i + 1), base: path.slice(i + 1) } : { dir: "", base: path };
}

const INDENT_PX = 14;

// ── One row in the changes list — moved here from GitTab as of G7 so it can
// double as the tree's leaf row (`showDir={false}`, indented by depth). ────
function FileRow({
  file,
  staged,
  active,
  busy,
  indent = 0,
  showDir = true,
  onSelect,
  onToggle,
  onDiscard,
}: {
  file: ChangedFile;
  staged: boolean;
  active: boolean;
  busy: boolean;
  /** Extra left padding (px) — used by `FileTree` to nest a leaf under its parent folders. */
  indent?: number;
  /** Render the greyed parent-dir prefix before the filename (flat-list default). Tree leaves pass `false` since nesting already conveys the folder. */
  showDir?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onDiscard: () => void;
}) {
  const { char, cls } = statusBadge(file, staged);
  const { dir, base } = showDir ? splitPath(file.path) : { dir: "", base: file.path.slice(file.path.lastIndexOf("/") + 1) };

  // Inline "Discard?" confirm, mirroring StashPanel's Drop confirm — Tauri
  // webview can't rely on window.confirm. Reset if the row is deselected
  // (user moved on to another file) so a stale confirm bar doesn't linger.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  if (!active && confirmDiscard) setConfirmDiscard(false);

  return (
    <div
      onClick={onSelect}
      style={indent ? { paddingLeft: indent } : undefined}
      className={`group flex items-center gap-2 mx-1 px-2 py-1 rounded-control cursor-pointer transition-colors duration-fast ${active ? "bg-accent-bg" : "hover:bg-white/[0.04]"}`}
    >
      <span className={`w-3 shrink-0 text-center font-mono text-[11px] ${cls}`}>{char}</span>
      <span className="flex-1 min-w-0 truncate font-mono text-[12px]" title={file.path}>
        {showDir && <span className="text-ink-3">{dir}</span>}
        <span className="text-ink">{base}</span>
      </span>
      {(file.insertions > 0 || file.deletions > 0) && (
        <span className="shrink-0 flex items-center gap-1 text-[11px] font-mono">
          {file.insertions > 0 && <span className="text-ok">+{file.insertions}</span>}
          {file.deletions > 0 && <span className="text-bad">−{file.deletions}</span>}
        </span>
      )}
      {confirmDiscard ? (
        <div className="shrink-0 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <span className="text-[11px] text-bad">Discard?</span>
          <button
            onClick={() => { onDiscard(); setConfirmDiscard(false); }}
            disabled={busy}
            className="text-[11px] font-medium text-bad hover:brightness-125 disabled:opacity-30 transition-colors duration-fast"
          >
            Confirm
          </button>
          <button
            onClick={() => setConfirmDiscard(false)}
            disabled={busy}
            className="text-[11px] text-ink-3 hover:text-ink-2 disabled:opacity-30 transition-colors duration-fast"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); setConfirmDiscard(true); }}
          disabled={busy}
          title="Discard changes"
          className="shrink-0 opacity-0 group-hover:opacity-100 text-ink-3 hover:text-bad disabled:opacity-30 transition-colors"
        >
          <TrashIcon />
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        disabled={busy}
        title={staged ? "Unstage" : "Stage"}
        className="shrink-0 text-ink-3 hover:text-ink disabled:opacity-30 transition-colors"
      >
        {staged ? <MinusIcon /> : <PlusIcon />}
      </button>
    </div>
  );
}

/**
 * Folder-nested, collapsible rendering of one Staged/Changes section — the
 * mockup-19 signature tree that replaced the flat `files.map(FileRow)` list.
 * Builds the tree from `files` via `buildFileTree` and recurses: directory
 * rows are a local chevron + folder icon + name that toggle a `collapsed`
 * `Set<string>` of dir paths (default: everything expanded); file rows reuse
 * `FileRow` at the right indent with `showDir={false}` since nesting already
 * conveys the folder. All per-file handlers/selection are threaded straight
 * through to the leaf, unchanged from the pre-G7 flat-list contract.
 */
export default function FileTree({
  files,
  staged,
  selected,
  mutating,
  onSelect,
  onToggle,
  onDiscard,
}: {
  files: ChangedFile[];
  /** Which section this tree renders — staged files vs. the working tree. */
  staged: boolean;
  selected: { path: string; staged: boolean } | null;
  /** Path of the file currently mid-mutation (stage/unstage/discard), or `null`. */
  mutating: string | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onDiscard: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggleDir(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNode(node: TreeNode, depth: number) {
    if (node.kind === "dir") {
      const isCollapsed = collapsed.has(node.path);
      return (
        <div key={`dir:${node.path}`}>
          <button
            onClick={() => toggleDir(node.path)}
            style={{ paddingLeft: depth * INDENT_PX }}
            className="w-full flex items-center gap-1.5 mx-1 px-2 py-1 rounded-control text-ink-2 hover:bg-surface-1 transition-colors duration-fast"
          >
            <ChevronRightIcon className={`shrink-0 transition-transform duration-fast ${isCollapsed ? "" : "rotate-90"}`} />
            <FolderIcon className="shrink-0" />
            <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-left" title={node.path}>{node.name}</span>
          </button>
          {!isCollapsed && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }
    const f = node.file;
    return (
      <FileRow
        key={`file:${node.path}`}
        file={f}
        staged={staged}
        active={selected?.path === f.path && selected?.staged === staged}
        busy={mutating === f.path}
        indent={depth * INDENT_PX}
        showDir={false}
        onSelect={() => onSelect(f.path)}
        onToggle={() => onToggle(f.path)}
        onDiscard={() => onDiscard(f.path)}
      />
    );
  }

  const nodes = buildFileTree(files);
  return <>{nodes.map((n) => renderNode(n, 0))}</>;
}
