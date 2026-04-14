import type { ReactNode } from "react";

interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}

export default function Tooltip({ label, children, side = "top", className }: TooltipProps) {
  const posClass =
    side === "top"    ? "bottom-full left-1/2 -translate-x-1/2 mb-1.5" :
    side === "bottom" ? "top-full left-1/2 -translate-x-1/2 mt-1.5" :
    side === "left"   ? "right-full top-1/2 -translate-y-1/2 mr-1.5" :
                        "left-full top-1/2 -translate-y-1/2 ml-1.5";

  const arrowClass =
    side === "top"    ? "top-full left-1/2 -translate-x-1/2 border-t-zinc-800 -mt-px border-4 border-transparent" :
    side === "bottom" ? "bottom-full left-1/2 -translate-x-1/2 border-b-zinc-800 mt-px border-4 border-transparent" :
    side === "left"   ? "left-full top-1/2 -translate-y-1/2 border-l-zinc-800 -ml-px border-4 border-transparent" :
                        "right-full top-1/2 -translate-y-1/2 border-r-zinc-800 -mr-px border-4 border-transparent";

  return (
    <div className={`relative group/tip ${className ?? ""}`}>
      {children}
      <div
        className={[
          "absolute z-[9999] pointer-events-none",
          posClass,
          "px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap",
          "bg-zinc-800 text-zinc-200 border border-white/[0.08] shadow-lg",
          "opacity-0 scale-95 group-hover/tip:opacity-100 group-hover/tip:scale-100",
          "transition-all duration-150 delay-200 group-hover/tip:delay-0",
        ].join(" ")}
      >
        {label}
        <span className={`absolute ${arrowClass}`} />
      </div>
    </div>
  );
}
