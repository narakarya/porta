import { useEffect } from "react";
import { usePortaStore } from "../../store";
import type { Notice } from "../../store/slices/notify";

const TONE: Record<Notice["kind"], { box: string; icon: string; title: string }> = {
  success: { box: "border-ok/25 bg-ok/[0.08]", icon: "text-ok", title: "text-ok" },
  error: { box: "border-red-500/25 bg-red-500/[0.08]", icon: "text-red-400", title: "text-red-300" },
  info: { box: "border-subtle bg-surface-2", icon: "text-ink-3", title: "text-ink" },
};

function Glyph({ kind, className }: { kind: Notice["kind"]; className: string }) {
  if (kind === "success") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`shrink-0 ${className}`}>
        <path d="M2 6.2l2.6 2.6L10 3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "error") {
    return (
      <svg width="12" height="12" viewBox="0 0 11 11" fill="none" className={`shrink-0 ${className}`}>
        <path d="M5.5 1.5l4 7H1.5l4-7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5.5 5v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="5.5" cy="8" r="0.5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`shrink-0 ${className}`}>
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 5.4V8.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6" cy="3.7" r="0.55" fill="currentColor" />
    </svg>
  );
}

function NoticeCard({ notice }: { notice: Notice }) {
  const dismiss = usePortaStore((s) => s.dismissNotice);
  const tone = TONE[notice.kind];

  useEffect(() => {
    if (notice.timeout === null) return;
    const t = setTimeout(() => dismiss(notice.id), notice.timeout);
    return () => clearTimeout(t);
  }, [notice.id, notice.timeout, dismiss]);

  return (
    <div
      role={notice.kind === "error" ? "alert" : "status"}
      className={`pointer-events-auto w-[320px] rounded-lg border px-3 py-2.5 shadow-lg shadow-black/30 backdrop-blur-[2px] ${tone.box}`}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-[3px] ${tone.icon}`}>
          <Glyph kind={notice.kind} className="" />
        </span>
        <p className={`flex-1 min-w-0 text-[12px] leading-snug ${tone.title}`}>{notice.message}</p>
        <button
          onClick={() => dismiss(notice.id)}
          title="Dismiss"
          aria-label="Dismiss"
          className="shrink-0 -mr-1 -mt-0.5 p-1 rounded text-ink-3 hover:text-ink transition-colors"
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {notice.detail && (
        <p className="mt-1.5 pl-[20px] text-[11px] font-mono leading-relaxed text-ink-3 break-words whitespace-pre-wrap select-text max-h-40 overflow-y-auto">
          {notice.detail}
        </p>
      )}
    </div>
  );
}

/**
 * App-wide notice stack, bottom-centre.
 *
 * Mounted at the App root on purpose. The previous save-confirmation toast
 * lived inside WorkspaceView, which App.tsx wraps in `hidden` whenever an app
 * is open in the workbench — `display: none` takes fixed-position descendants
 * with it, so that toast could never appear from the surface that triggers it.
 */
export default function Notices() {
  const notices = usePortaStore((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[70] flex flex-col-reverse items-center gap-2 pointer-events-none">
      {notices.map((n) => (
        <NoticeCard key={n.id} notice={n} />
      ))}
    </div>
  );
}
