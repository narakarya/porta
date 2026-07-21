/**
 * The git tab's failure line: a scrollable monospace block that keeps git's own
 * wording verbatim, because the exact stderr is usually the fix.
 *
 * There is exactly one of these on screen at a time, rendered by the shell —
 * the tab body reports its failure upward instead of drawing a second box, so a
 * shell error and a tab error can never stack.
 */
export default function ErrorNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <pre className="shrink-0 text-[11px] font-mono text-bad whitespace-pre-wrap break-words max-h-32 overflow-y-auto rounded-control border border-subtle bg-surface-code px-2.5 py-2 m-3 mb-0">
      {message}
    </pre>
  );
}
