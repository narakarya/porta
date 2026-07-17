import type { ReactNode } from "react";

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] text-center gap-2">
      {icon && <div className="w-11 h-11 rounded-xl bg-white/[0.04] flex items-center justify-center text-ink-3">{icon}</div>}
      <h2 className="text-[15px] font-medium text-ink">{title}</h2>
      {hint && <p className="text-[12px] text-ink-3 max-w-xs">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-white/[0.06] rounded ${className}`} />;
}

/**
 * Inline loading spinner. Inherits `currentColor` so it tints to the parent's
 * text color; size via the `size` prop (px). Used inside async buttons and
 * anywhere a control is waiting on a round-trip.
 */
export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={`animate-spin shrink-0 ${className}`}
      role="status"
      aria-label="Loading"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
