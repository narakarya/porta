import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  anchor: ReactNode; // the trigger element (rendered inline)
  children: ReactNode; // popover content
  align?: "left" | "right";
  width?: string;
}

export default function Popover({ open, onClose, anchor, children, align = "left", width = "w-52" }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div className="relative inline-block" ref={ref}>
      {anchor}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={onClose} />
          <div
            className={`absolute ${align === "right" ? "right-0" : "left-0"} mt-1 z-50 ${width} max-h-64 overflow-y-auto p-1 bg-surface-2 border border-strong rounded-lg shadow-xl`}
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}
