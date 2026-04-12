import { useEffect, useRef } from "react";

interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function WorkspaceContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Clamp to viewport
  const menuWidth = 160;
  const menuHeight = items.length * 32 + 8;
  const left = Math.min(x, window.innerWidth - menuWidth - 8);
  const top = Math.min(y, window.innerHeight - menuHeight - 8);

  return (
    <div
      ref={ref}
      style={{ left, top }}
      className="fixed z-[100] w-[160px] bg-[#2a2a2c] border border-white/[0.10] rounded-xl shadow-2xl py-1 overflow-hidden"
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => { item.onClick(); onClose(); }}
          className={`w-full text-left px-3 py-1.5 text-[13px] transition-colors ${
            item.danger
              ? "text-red-400 hover:bg-red-500/10"
              : "text-zinc-200 hover:bg-white/[0.07]"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
