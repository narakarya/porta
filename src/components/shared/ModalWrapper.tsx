import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

export default function ModalWrapper({ onClose, children, className }: Props) {
  // Tracks whether the press-and-release both started on the overlay. Prevents
  // accidental close when:
  //   - user drags from inside the modal panel out to the overlay
  //   - a native dialog (file picker, NSOpenPanel) re-routes a click event to
  //     the overlay after the picker dismisses
  const downOnOverlayRef = useRef(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        downOnOverlayRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnOverlayRef.current && e.target === e.currentTarget) {
          onClose();
        }
        downOnOverlayRef.current = false;
      }}
    >
      <div className={`relative ${className ?? "bg-[#1a1a1c] border border-white/[0.08] rounded-2xl shadow-2xl"}`} onMouseDown={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
          title="Close (Esc)"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
        {children}
      </div>
    </div>
  );
}
