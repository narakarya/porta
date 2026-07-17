import type { ReactNode, HTMLAttributes } from "react";

/**
 * SidebarShell — one source of truth for the sidebar frame + its repeated
 * bits, so the Workspaces sidebar (`Sidebar.tsx`) and the Hosts sidebar
 * (`HostVault.tsx`) stop hand-rolling the same frame / group header / add
 * button. Row *content* stays with each caller (workspaces keep their
 * drag/instances/context-menu; hosts keep OS icons/two-line rows/context-menu);
 * only the shared shell lives here.
 */

// ── Frame ────────────────────────────────────────────────────────────────────

/**
 * The `<aside>` container. macOS note: the window needs a top drag-region to
 * move it + clear the traffic-lights — that lives in {@link SidebarHeader},
 * which callers place as the first child here.
 */
export function SidebarFrame({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <aside
      className={`w-[216px] bg-[#0d0d0f] border-r border-white/[0.07] flex flex-col pb-2 shrink-0 ${className ?? ""}`}
    >
      {children}
    </aside>
  );
}

/**
 * Top drag-region block (REQUIRED on macOS — moves the window + clears the
 * traffic-light buttons). Interactive children inside must opt out with the
 * `no-drag` class.
 */
export function SidebarHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`drag-region px-3.5 pt-3 pb-2 shrink-0 flex items-start gap-2 ${className ?? ""}`}>
      {children}
    </div>
  );
}

/** Scrollable body slot. Pass layout (padding/gap) via `className`. */
export function SidebarBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`flex-1 overflow-y-auto overflow-x-hidden no-drag ${className ?? ""}`}>{children}</div>
  );
}

/** Footer slot (add-button area / status row). Top-bordered, non-draggable. */
export function SidebarFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`px-2 pt-2 border-t border-white/[0.06] no-drag ${className ?? ""}`}>{children}</div>
  );
}

// ── Group header ──────────────────────────────────────────────────────────────

export interface SidebarGroupHeaderProps {
  /** Uppercase group label. */
  label: string;
  /** Muted trailing count (only rendered when > 0). */
  count?: number;
  /** "+" affordance on the right. Omit to hide it. */
  onAdd?: () => void;
  /** Tooltip / aria-label for the "+" button. */
  addTitle?: string;
  addLabel?: string;
  /** Renders a leading collapse chevron when `onToggle` is provided. */
  collapsed?: boolean;
  onToggle?: () => void;
  /**
   * Extra container classes — text color, cursor, drag ghost opacity, etc.
   * Defaults to the muted `text-ink-3` used by the Hosts sidebar.
   */
  className?: string;
  /** Nodes rendered just before the count (e.g. an update badge). */
  beforeCount?: ReactNode;
  /**
   * Full override of the right-side cluster (e.g. a collapsed rollup). When
   * set, `beforeCount` / `count` / the add button are not rendered.
   */
  end?: ReactNode;
  /**
   * Spread onto the container: onClick, onContextMenu, onMouseDown, onKeyDown,
   * `data-*`, style, role, tabIndex, etc. Lets the Workspaces sidebar keep its
   * drag-reorder wiring on the header while sharing the visual shell.
   */
  containerProps?: HTMLAttributes<HTMLDivElement> & Record<string, unknown>;
}

/**
 * The uppercase group header shared by workspace groups / host groups: 10.5px
 * font-medium tracked label, an optional collapse chevron, a muted count, and a
 * "+" affordance. The right cluster can be fully swapped via `end`.
 */
export function SidebarGroupHeader({
  label,
  count,
  onAdd,
  addTitle,
  addLabel,
  collapsed,
  onToggle,
  className = "text-ink-3",
  beforeCount,
  end,
  containerProps,
}: SidebarGroupHeaderProps) {
  return (
    <div
      className={`group/sgh flex items-center gap-1 px-1.5 py-1 mt-1.5 rounded-[6px] text-[10.5px] font-medium uppercase tracking-[0.05em] transition-colors ${className}`}
      {...containerProps}
    >
      {onToggle && (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="shrink-0 p-0.5 text-ink-3 hover:text-zinc-300"
          title={collapsed ? "Expand" : "Collapse"}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
          >
            <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <span className="flex-1 truncate">{label}</span>
      {end ?? (
        <>
          {beforeCount}
          {typeof count === "number" && count > 0 && (
            <span className="text-[10px] text-ink-3 tabular-nums normal-case tracking-normal">{count}</span>
          )}
          {onAdd && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
              title={addTitle}
              aria-label={addLabel ?? addTitle}
              className="shrink-0 -mr-0.5 p-0.5 rounded text-accent hover:text-accent-ink transition-colors"
            >
              <PlusGlyph size={13} />
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── Add button ────────────────────────────────────────────────────────────────

export interface SidebarAddButtonProps {
  label: string;
  onClick: () => void;
  /** Leading icon; defaults to the "+" glyph. */
  icon?: ReactNode;
  title?: string;
  /** Extra classes (e.g. outer margin). */
  className?: string;
}

/** Full-width footer add affordance ("Add App" / "Add host"), token-styled. */
export function SidebarAddButton({ label, onClick, icon, title, className }: SidebarAddButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center justify-center gap-1.5 w-full px-2 py-1.5 rounded-[6px] text-[12px] text-ink-2 border border-subtle hover:bg-white/[0.05] hover:text-ink transition-colors ${className ?? ""}`}
    >
      {icon ?? <PlusGlyph size={11} />}
      {label}
    </button>
  );
}

// ── Shared glyph ──────────────────────────────────────────────────────────────

function PlusGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
      <path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
