import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  delayMs?: number;
}

const SHOW_DELAY_DEFAULT = 200;
const VIEWPORT_PAD = 6;

// Portal-based tooltip. Renders into document.body so ancestor `overflow:hidden`
// (e.g. <main overflow-x-hidden>) can't clip it. Position is recomputed on
// scroll/resize and clamped to viewport edges.
export default function Tooltip({ label, children, side = "top", className, delayMs }: TooltipProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  function clearShowTimer() {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  }

  function onEnter() {
    clearShowTimer();
    showTimer.current = window.setTimeout(
      () => setVisible(true),
      delayMs ?? SHOW_DELAY_DEFAULT,
    );
  }

  function onLeave() {
    clearShowTimer();
    setVisible(false);
  }

  useEffect(() => () => clearShowTimer(), []);

  // Recompute on visibility, scroll, resize. Use layout effect for first paint
  // so the tooltip never flashes at (0,0).
  useLayoutEffect(() => {
    if (!visible) {
      setCoords(null);
      return;
    }
    function update() {
      const trigger = triggerRef.current;
      const tip = tipRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const tw = tip?.offsetWidth ?? 0;
      const th = tip?.offsetHeight ?? 0;
      const gap = 6;

      let top = 0;
      let left = 0;
      switch (side) {
        case "top":    top = r.top - th - gap;          left = r.left + r.width / 2 - tw / 2; break;
        case "bottom": top = r.bottom + gap;            left = r.left + r.width / 2 - tw / 2; break;
        case "left":   top = r.top + r.height / 2 - th / 2; left = r.left - tw - gap;         break;
        case "right":  top = r.top + r.height / 2 - th / 2; left = r.right + gap;             break;
      }

      // Clamp to viewport so the tooltip never falls off-screen.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      left = Math.max(VIEWPORT_PAD, Math.min(left, vw - tw - VIEWPORT_PAD));
      top = Math.max(VIEWPORT_PAD, Math.min(top, vh - th - VIEWPORT_PAD));

      setCoords({ top, left });
    }
    update();
    // capture: catch scrolls in any ancestor scroll container.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [visible, side, label]);

  return (
    <>
      <div
        ref={triggerRef}
        className={`relative ${className ?? ""}`}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
        // Clicking dismisses it: several triggers open a popover right where
        // the tooltip sits, and it would otherwise hang over that popover
        // until the pointer happened to leave.
        onMouseDown={onLeave}
      >
        {children}
      </div>
      {visible && createPortal(
        <div
          ref={tipRef}
          role="tooltip"
          className={[
            "fixed z-[9999] pointer-events-none",
            // `pre`, not `nowrap`: both refuse to wrap, but `pre` also honours
            // the newlines in a multi-line label (the rail's version tooltip
            // lists setup issues one per line).
            "px-2 py-1 rounded-md text-[11px] font-medium whitespace-pre",
            "bg-zinc-800 text-zinc-200 border border-white/[0.08] shadow-lg",
            coords ? "opacity-100" : "opacity-0",
            "transition-opacity duration-100",
          ].join(" ")}
          style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999 }}
        >
          {label}
        </div>,
        document.body,
      )}
    </>
  );
}
