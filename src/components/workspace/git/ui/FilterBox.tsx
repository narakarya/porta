/**
 * The filter input every git panel has. Controlled, so the owning tab keeps the
 * query in its own state and the input never remounts on data refresh — that
 * remount is what used to eat focus and caret position.
 */
export default function FilterBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="search"
      className="input-base"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      autoComplete="off"
    />
  );
}
