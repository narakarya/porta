import type { ReactNode } from "react";

interface Props {
  onClick?: () => void;
  active?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}

// Dense, hover-highlighted row — the workhorse for sidebars/vaults/lists.
export default function ListRow({ onClick, active, leading, trailing, children }: Props) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors duration-fast ${
        active ? "bg-accent-bg text-ink" : "text-ink hover:bg-white/[0.05]"
      }`}
    >
      {leading}
      <span className="min-w-0 flex-1">{children}</span>
      {trailing}
    </Comp>
  );
}
