import type { ReactNode } from "react";

interface TooltipProps {
  label: string;
  children: ReactNode;
  /** Default: "top". Use "bottom" for items near the top of the screen. */
  side?: "top" | "bottom";
  /** Extra wrapper class (e.g. "flex") */
  className?: string;
}

/**
 * Lightweight tooltip for icon-only buttons.
 * Uses CSS group-hover — no JS, no portals, zero deps.
 *
 * Usage:
 *   <Tooltip label="Restart">
 *     <button>...</button>
 *   </Tooltip>
 */
export default function Tooltip({ label, children, side = "top", className }: TooltipProps) {
  const above = side === "top";

  return (
    <div className={`relative group/tip ${className ?? ""}`}>
      {children}
      <div
        className={[
          // positioning
          "absolute left-1/2 -translate-x-1/2 z-[9999] pointer-events-none",
          above ? "bottom-full mb-1.5" : "top-full mt-1.5",
          // appearance
          "px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap",
          "bg-zinc-800 text-zinc-200 border border-white/[0.08] shadow-lg",
          // visibility
          "opacity-0 scale-95 group-hover/tip:opacity-100 group-hover/tip:scale-100",
          "transition-all duration-150 delay-200 group-hover/tip:delay-0",
        ].join(" ")}
      >
        {label}
        {/* Arrow */}
        <span
          className={[
            "absolute left-1/2 -translate-x-1/2 border-4 border-transparent",
            above
              ? "top-full border-t-zinc-800 -mt-px"
              : "bottom-full border-b-zinc-800 mt-px",
          ].join(" ")}
        />
      </div>
    </div>
  );
}
