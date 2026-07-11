import type { RefObject } from "react";

export interface EditorSearchBarProps {
  query: string;
  matchIndex: number;
  matchCount: number;
  onQueryChange: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}

export default function EditorSearchBar({
  query, matchIndex, matchCount, onQueryChange, onNext, onPrev, onClose, inputRef,
}: EditorSearchBarProps) {
  const counter = query === "" ? "" : matchCount === 0 ? "0/0" : `${matchIndex + 1}/${matchCount}`;
  return (
    <div className="flex items-center gap-1 bg-[#0d0d0f] border border-white/[0.12] rounded-md px-1.5 py-1 focus-within:border-blue-500/60 transition-colors">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
        placeholder="Find…"
        spellCheck={false}
        className="w-40 bg-transparent text-[12px] font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none px-1"
      />
      <span className="text-[10px] font-mono text-zinc-500 tabular-nums min-w-[34px] text-right select-none">{counter}</span>
      <button type="button" onClick={onPrev} disabled={matchCount === 0} title="Previous (Shift+Enter)"
        className="p-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] rounded disabled:opacity-30 transition-colors">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 6.5L5 3l3 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      <button type="button" onClick={onNext} disabled={matchCount === 0} title="Next (Enter)"
        className="p-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] rounded disabled:opacity-30 transition-colors">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5L5 7l3-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      <button type="button" onClick={onClose} title="Close (Esc)"
        className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded transition-colors">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
      </button>
    </div>
  );
}
