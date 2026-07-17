import type { ReactNode } from "react";

export type Status = "running" | "stopped" | "error" | "update" | "connecting";
type Tone = "neutral" | "accent" | "ok" | "warn" | "bad";

const DOT: Record<Status, string> = {
  running: "bg-ok",
  stopped: "bg-ink-3",
  error: "bg-bad",
  update: "bg-warn",
  connecting: "bg-accent animate-pulse",
};

export function StatusDot({ status, className = "" }: { status: Status; className?: string }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${DOT[status]} ${className}`} />;
}

const BADGE: Record<Tone, string> = {
  neutral: "text-ink-2 bg-white/[0.06]",
  accent: "text-accent-ink bg-accent-bg",
  ok: "text-ok bg-ok-bg",
  warn: "text-warn bg-warn-bg",
  bad: "text-bad bg-bad-bg",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] leading-none px-2 py-0.5 rounded-full ${BADGE[tone]}`}>
      {children}
    </span>
  );
}
