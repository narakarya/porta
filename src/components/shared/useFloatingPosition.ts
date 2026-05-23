import { useLayoutEffect, useState, type RefObject } from "react";

export type FloatingSide = "top" | "bottom" | "left" | "right";
export type FloatingAlign = "start" | "center" | "end";

export interface FloatingCoords {
  top: number;
  left: number;
}

const VIEWPORT_PAD = 6;

// Computes fixed-viewport coordinates for a floating panel anchored to a
// trigger element. Use with React portals to escape ancestor `overflow:hidden`.
//
// `panelSize` lets the caller pass the panel's measured size after first paint
// (via a ref) so we can clamp against viewport edges precisely. If unknown
// (first frame), the panel is positioned without clamping; pass it on the
// second pass for stable placement.
export function useFloatingPosition({
  triggerRef,
  panelSize,
  active,
  side = "bottom",
  align = "start",
  gap = 4,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  panelSize: { width: number; height: number } | null;
  active: boolean;
  side?: FloatingSide;
  align?: FloatingAlign;
  gap?: number;
}): FloatingCoords | null {
  const [coords, setCoords] = useState<FloatingCoords | null>(null);

  useLayoutEffect(() => {
    if (!active) {
      setCoords(null);
      return;
    }
    function update() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const pw = panelSize?.width ?? 0;
      const ph = panelSize?.height ?? 0;

      let top = 0;
      let left = 0;
      if (side === "bottom" || side === "top") {
        top = side === "bottom" ? r.bottom + gap : r.top - ph - gap;
        if (align === "start") left = r.left;
        else if (align === "end") left = r.right - pw;
        else left = r.left + r.width / 2 - pw / 2;
      } else {
        left = side === "right" ? r.right + gap : r.left - pw - gap;
        if (align === "start") top = r.top;
        else if (align === "end") top = r.bottom - ph;
        else top = r.top + r.height / 2 - ph / 2;
      }

      // Clamp to viewport when panel size is known.
      if (panelSize) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        left = Math.max(VIEWPORT_PAD, Math.min(left, vw - pw - VIEWPORT_PAD));
        top = Math.max(VIEWPORT_PAD, Math.min(top, vh - ph - VIEWPORT_PAD));
      }

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
  }, [active, side, align, gap, triggerRef, panelSize?.width, panelSize?.height]);

  return coords;
}

// Convenience: imperatively measure a panel element's size for two-pass
// positioning. Pass the measured size back into useFloatingPosition.
export function useMeasuredSize<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setSize(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ width: el.offsetWidth, height: el.offsetHeight });
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, [active, ref]);
  return size;
}
