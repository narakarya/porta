import type { ReactNode } from "react";

export interface TabItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
}

interface Props {
  tabs: TabItem[];
  active: string;
  onSelect: (id: string) => void;
  trailing?: ReactNode;
}

export default function Tabs({ tabs, active, onSelect, trailing }: Props) {
  return (
    <div className="flex items-center gap-1 border-b border-subtle px-2">
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-[12px] -mb-px border-b transition-colors duration-fast ${
              on ? "text-ink border-accent" : "text-ink-2 border-transparent hover:text-ink"
            }`}
          >
            {t.icon && <span className={`shrink-0 ${on ? "text-accent" : "text-ink-3"}`}>{t.icon}</span>}
            {t.label}
            {t.badge}
          </button>
        );
      })}
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}
