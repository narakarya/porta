import { useEffect, useRef } from "react";

/**
 * Read-only streaming log pane for the Publish tab's tunnel output ("the
 * terminal publish"). Not an xterm — a lightweight scroll container that
 * auto-scrolls to the latest line as long as the user hasn't scrolled up to
 * read history. Blank-line-keeps-height trick mirrors `git/diffLines.tsx`.
 */
export default function PublishLog({ lines }: { lines: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stuckToBottom = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (el && stuckToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="max-h-64 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 font-mono text-[11px] text-ink-2"
    >
      {lines.length === 0 ? (
        <div className="text-ink-3">No tunnel output yet — start the tunnel to stream logs.</div>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="whitespace-pre">
            {line === "" ? " " : line}
          </div>
        ))
      )}
    </div>
  );
}
