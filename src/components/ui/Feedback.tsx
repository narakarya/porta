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
