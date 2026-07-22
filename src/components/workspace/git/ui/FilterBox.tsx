import { Input } from "../../../ui";

/**
 * The filter input every git panel has. Controlled, so the owning tab keeps the
 * query in its own state and the input never remounts on data refresh — that
 * remount is what used to eat focus and caret position.
 *
 * Built on the shared `Input`, whose styling is token-based
 * (`bg-surface-input`, `border-subtle`, `text-ink`). That matters here more
 * than elsewhere: the git tab re-points those variables per palette, so the
 * literal dark values of `.input-base` would render a near-black field on a
 * light palette like `paper`.
 */
export default function FilterBox({
  value,
  onChange,
  placeholder,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** Density override for tight columns (the Status tab's 240px file list). */
  className?: string;
}) {
  return (
    <Input
      type="search"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      autoComplete="off"
      className={className}
    />
  );
}
