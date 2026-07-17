import { useEffect, type ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode; // popover content
  /** The trigger element, rendered inline. Omit for standalone/card popovers
   *  that position themselves (e.g. the updater card anchored to the rail). */
  anchor?: ReactNode;
  align?: "left" | "right";
  width?: string;
  /**
   * "menu" (default) — dropdown chrome: capped height, scroll, padding, the
   * surface-2 skin, and a dismiss-on-outside-click backdrop.
   * "card" — a rich, caller-styled panel: no default chrome or backdrop, so the
   * caller owns positioning + skin via {@link panelClassName}. Used by the
   * single update popover so it shares this component's Escape handling.
   */
  variant?: "menu" | "card";
  /** Extra panel classes (menu: appended; card: the only panel classes). */
  panelClassName?: string;
  /** Close on Escape. Default true; set false for states that must not be
   *  interrupted (e.g. an in-flight download/install). */
  closeOnEscape?: boolean;
  /** Dismiss-on-outside-click backdrop. Defaults to true for menus, false for cards. */
  backdrop?: boolean;
}

export default function Popover({
  open,
  onClose,
  children,
  anchor,
  align = "left",
  width = "w-52",
  variant = "menu",
  panelClassName,
  closeOnEscape = true,
  backdrop,
}: Props) {
  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, closeOnEscape]);

  const showBackdrop = backdrop ?? variant === "menu";

  const panel =
    variant === "menu" ? (
      <div
        className={`absolute ${align === "right" ? "right-0" : "left-0"} mt-1 z-50 ${width} max-h-64 overflow-y-auto p-1 bg-surface-2 border border-strong rounded-lg shadow-xl ${panelClassName ?? ""}`}
      >
        {children}
      </div>
    ) : (
      <div className={panelClassName ?? ""}>{children}</div>
    );

  // Keep the inline trigger mounted whether open or not.
  if (!open) return anchor ? <div className="relative inline-block">{anchor}</div> : null;

  const layer = (
    <>
      {showBackdrop && <div className="fixed inset-0 z-40" onClick={onClose} />}
      {panel}
    </>
  );

  return anchor ? (
    <div className="relative inline-block">
      {anchor}
      {layer}
    </div>
  ) : (
    layer
  );
}
