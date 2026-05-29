import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Tooltip from "../shared/Tooltip";
import { useFloatingPosition, useMeasuredSize } from "../shared/useFloatingPosition";

interface Props {
  hostsMenuOpen: boolean;
  setHostsMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  hosts: string[];
  scheme: string;
}

/**
 * The "open in browser" button that fans out to multiple hostnames when an
 * app has `extra_subdomains`. Renders the host list in a portal so it isn't
 * clipped by the workspace's `overflow: hidden`. Click-outside and Escape
 * close it.
 *
 * Lifted out of `AppCard.tsx` to keep that file readable; nothing else
 * depends on it and the local state (hostsMenuOpen) is owned by the parent
 * so multiple cards' menus don't fight over a single ref.
 */
export default function HostsDropdown({
  hostsMenuOpen,
  setHostsMenuOpen,
  hosts,
  scheme,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelSize = useMeasuredSize(panelRef, hostsMenuOpen);
  const coords = useFloatingPosition({
    triggerRef,
    panelSize,
    active: hostsMenuOpen,
    side: "bottom",
    align: "end",
    gap: 4,
  });

  useEffect(() => {
    if (!hostsMenuOpen) return;
    function onPointer(e: PointerEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setHostsMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setHostsMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [hostsMenuOpen, setHostsMenuOpen]);

  return (
    <>
      <Tooltip label="Open in browser">
        <button
          ref={triggerRef}
          onClick={(e) => { e.stopPropagation(); setHostsMenuOpen((v) => !v); }}
          className="p-1 text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M5.5 2.5H3a.5.5 0 00-.5.5v7a.5.5 0 00.5.5h7a.5.5 0 00.5-.5V8M7.5 2.5H10.5M10.5 2.5V5.5M10.5 2.5L6.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </Tooltip>
      {hostsMenuOpen && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[60] min-w-[180px] bg-[#1c1c1e] border border-white/[0.10] rounded-lg shadow-xl overflow-hidden"
          style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
        >
          {hosts.map((h) => (
            <a
              key={h}
              href={`${scheme}://${h}`}
              target="_blank"
              rel="noreferrer"
              onClick={() => setHostsMenuOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-[12px] font-mono text-zinc-300 hover:bg-white/[0.07] transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-zinc-600 shrink-0">
                <path d="M4 1.5H2a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h6a.5.5 0 00.5-.5V6M5.5 1.5H8.5M8.5 1.5V4.5M8.5 1.5L5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {h}
            </a>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
