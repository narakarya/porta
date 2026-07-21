import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * Right-click menu for list rows. The extension exposed row actions through the
 * native contextmenu event; core previously only had an overflow button, which
 * is the affordance gap this closes.
 */
export type ContextMenuItem = {
  id: string;
  label: string;
  danger?: boolean;
  onSelect: () => void;
};

export type ContextMenuBinding = {
  /** Spread onto whatever element is the row — a `<tr>`, a flex child, an `<li>`. */
  onContextMenu: (e: React.MouseEvent) => void;
  /** The open menu, or null. Render it anywhere: it positions itself `fixed`. */
  menu: React.ReactNode;
  /** Close it programmatically — e.g. when the row it belongs to goes away. */
  close: () => void;
};

/**
 * Owns the menu's open state, its global key/pointer listeners and the viewport
 * clamp, and hands back a handler plus the rendered menu.
 *
 * A hook rather than a wrapper component on purpose: the consumers are list and
 * diff rows, and a component that wrapped `children` in a `<div>` would be
 * illegal inside a `<tbody>` and would break any flex/grid parent that expects
 * the row to be its own direct child. Here the caller keeps its element and
 * only spreads a prop onto it, so no markup is imposed at all.
 */
export function useContextMenu(items: ContextMenuItem[]): ContextMenuBinding {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setAt(null), []);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setAt({ x: e.clientX, y: e.clientY });
  }, []);

  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAt(null);
    };
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setAt(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [at]);

  // Clamp the menu into the viewport. `at` is the raw click point; once the
  // menu has actually rendered we know its real size and can nudge it back
  // on-screen before the browser paints, so a right-click near the right or
  // bottom edge never opens a menu that's partly (or fully) off-screen.
  useLayoutEffect(() => {
    if (!at || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const margin = 4;
    let x = at.x;
    let y = at.y;
    if (x + rect.width > window.innerWidth - margin) {
      x = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (y + rect.height > window.innerHeight - margin) {
      y = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    menuRef.current.style.left = `${x}px`;
    menuRef.current.style.top = `${y}px`;
  }, [at]);

  const menu = useMemo(() => {
    if (!at) return null;
    return (
      <div
        ref={menuRef}
        role="menu"
        style={{ left: at.x, top: at.y }}
        className="fixed z-50 min-w-[160px] py-1 rounded-[var(--radius)] border border-subtle bg-surface-2 shadow-lg"
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            onClick={() => {
              setAt(null);
              item.onSelect();
            }}
            className={
              "block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--hover)] " +
              (item.danger ? "text-bad" : "text-ink")
            }
          >
            {item.label}
          </button>
        ))}
      </div>
    );
  }, [at, items]);

  return { onContextMenu, menu, close };
}
