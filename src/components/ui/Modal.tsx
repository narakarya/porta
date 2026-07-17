import { useEffect, type ReactNode } from "react";

interface Props {
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string; // tailwind width class, e.g. "w-96"
}

export default function Modal({ onClose, title, children, footer, width = "w-96" }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className={`${width} max-h-[85vh] overflow-y-auto bg-surface-2 border border-subtle rounded-card`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="px-4 pt-4 text-[14px] font-medium text-ink">{title}</div>
        )}
        <div className="p-4 space-y-3">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-subtle bg-surface-1 rounded-b-card">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
