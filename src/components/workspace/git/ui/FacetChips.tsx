/**
 * Facet row — All / Merged / Unmerged / Local-only / On remote, and friends.
 * Ported from the extension's Branches tab, generic so other tabs can reuse it.
 */
export default function FacetChips<T extends string>({
  facets,
  active,
  onSelect,
}: {
  facets: { id: T; label: string; count?: number }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {facets.map((f) => {
        const on = f.id === active;
        return (
          <button
            key={f.id}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(f.id)}
            className={
              "px-2 py-1 rounded-control text-[12px] transition-colors " +
              (on
                ? "bg-accent-bg text-accent-ink"
                : "text-ink-2 hover:bg-[var(--hover)]")
            }
          >
            {f.label}
            {f.count !== undefined && (
              <span className="ml-1.5 text-ink-3 tabular-nums">{f.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
