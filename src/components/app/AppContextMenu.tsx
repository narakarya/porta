import { useEffect, useRef } from "react";

interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: (MenuItem | "separator")[];
  onClose: () => void;
}

export default function AppContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Position so menu stays inside viewport
  const menuWidth = 200;
  const left = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const estimatedHeight = items.length * 32;
  const top = y + estimatedHeight > window.innerHeight ? y - estimatedHeight : y;

  useEffect(() => {
    function handler(e: MouseEvent | KeyboardEvent) {
      if (e instanceof KeyboardEvent && e.key === "Escape") { onClose(); return; }
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ left, top }}
      className="fixed z-50 w-[200px] bg-[#232325] border border-white/[0.10] rounded-xl shadow-2xl py-1 overflow-hidden"
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="my-1 border-t border-white/[0.06]" />
        ) : (
          <button
            key={i}
            onClick={() => { item.onClick(); onClose(); }}
            disabled={item.disabled}
            className={`flex items-center gap-2.5 w-full px-3 py-1.5 text-[13px] text-left transition-colors disabled:opacity-30 ${
              item.danger
                ? "text-red-400 hover:bg-red-500/10"
                : "text-zinc-200 hover:bg-white/[0.07]"
            }`}
          >
            {item.icon && <span className="shrink-0 text-zinc-500">{item.icon}</span>}
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
