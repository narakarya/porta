import { useEffect, useLayoutEffect, useRef, useState } from "react";

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

export default function ContextMenu({
  items,
  children,
}: {
  items: ContextMenuItem[];
  children: React.ReactNode;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAt(null);
    };
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) setAt(null);
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
    if (!at || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    const margin = 4;
    let x = at.x;
    let y = at.y;
    if (x + rect.width > window.innerWidth - margin) {
      x = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (y + rect.height > window.innerHeight - margin) {
      y = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    menu.current.style.left = `${x}px`;
    menu.current.style.top = `${y}px`;
  }, [at]);

  return (
    <>
      {/* Renders a block-level `<div>` wrapper around `children`. Fine for the
          current callers, but a row that is itself a `<tr>` or a flex/grid
          item will have this wrapper break its layout — revisit the API
          (e.g. an `as`/render-prop escape hatch) when the Status-tab phase
          brings the first consumer that needs one. */}
      <div
        onContextMenu={(e) => {
          e.preventDefault();
          setAt({ x: e.clientX, y: e.clientY });
        }}
      >
        {children}
      </div>
      {at && (
        <div
          ref={menu}
          role="menu"
          style={{ left: at.x, top: at.y }}
          className="fixed z-50 min-w-[160px] py-1 rounded-[var(--radius)] border border-[var(--border-subtle)] bg-[var(--surface-2)] shadow-lg"
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
                (item.danger ? "text-[var(--danger)]" : "text-[var(--ink-1)]")
              }
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
