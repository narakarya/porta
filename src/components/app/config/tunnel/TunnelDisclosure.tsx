import type { ReactNode } from "react";

/** Folding section used for "Settings" and "Advanced" (mockup 32).
 *
 * The summary is the whole point: a folded section must still say what is
 * inside it, or folding just hides state. Callers pass a short right-aligned
 * description of the current values ("named · 1 host", "auto-start off · no
 * alias") so nothing configured is ever invisible. */
export default function TunnelDisclosure({
  open,
  onToggle,
  label,
  summary,
  tone = "default",
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  summary?: ReactNode;
  /** "warn" tints the summary — used for the unapplied-changes count. */
  tone?: "default" | "warn";
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg bg-surface-2 border border-subtle overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex items-center gap-2 w-full px-3 py-2 text-[12px] text-left transition-colors hover:bg-white/[0.03] ${
          open ? "text-ink border-b border-subtle" : "text-ink-2"
        }`}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          className={`text-ink-3 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label}
        {summary && (
          <span className={`ml-auto text-[10px] font-mono truncate ${tone === "warn" ? "text-warn" : "text-ink-3"}`}>
            {summary}
          </span>
        )}
      </button>
      {open && <div className="p-3 flex flex-col gap-3">{children}</div>}
    </div>
  );
}
