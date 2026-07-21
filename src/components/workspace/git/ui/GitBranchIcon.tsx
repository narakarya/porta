/**
 * The 13px branch glyph the git tab uses in its header pill and its clean-tree
 * empty state. Inline rather than an icon font so the tab carries no icon
 * dependency — shared so the shell and each tab draw the same one.
 */
export default function GitBranchIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="4.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.25v5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11.5 6.25c0 2.6-1.9 3.5-4.2 3.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
