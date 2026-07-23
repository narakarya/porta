import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import type { App } from "../../types";
import TerminalWorkspace from "./TerminalWorkspace";

export type { SessionRequest } from "./TerminalWorkspace";
import type { SessionRequest } from "./TerminalWorkspace";

interface Props {
  initialApp: App;
  isOpen: boolean;
  onClose: () => void;
  pendingSession: SessionRequest | null;
}

/**
 * Full-screen / bottom-docked terminal opened from the app grid. Owns only the
 * placement chrome (container, resize handle, title, close); the tabs, splits,
 * search and shortcuts all live in the shared TerminalWorkspace so the
 * workbench's Terminal tab gets exactly the same surface.
 */
export default function TerminalModal({ initialApp, isOpen, onClose, pendingSession }: Props) {
  // Placement is persisted in UI slice (localStorage-backed) so the user
  // doesn't have to re-dock the terminal every session.
  const { placement, panelHeight, setPlacement, setPanelHeight } = usePortaStore(
    useShallow((s) => ({
      placement: s.terminalPlacement,
      panelHeight: s.terminalPanelHeight,
      setPlacement: s.setTerminalPlacement,
      setPanelHeight: s.setTerminalPanelHeight,
    })),
  );

  // Drag-to-resize for panel mode. Records the last height seen during
  // the drag so it can be committed on mouseup (closure over React state
  // would capture the start value, not the running one).
  function beginResize(e: React.MouseEvent) {
    if (placement !== "panel") return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeight;
    let lastH = startH;
    const onMove = (ev: MouseEvent) => {
      const delta = (startY - ev.clientY) / window.innerHeight;
      lastH = Math.max(0.15, Math.min(0.92, startH + delta));
      setPanelHeight(lastH);
    };
    const onUp = () => {
      setPanelHeight(lastH); // commit final value to localStorage
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const containerClass = placement === "panel"
    ? "fixed left-0 right-0 bottom-0 z-50 bg-[#111113] flex flex-col border-t-2 border-white/[0.12] shadow-[0_-12px_28px_rgba(0,0,0,0.45)]"
    : "fixed inset-0 z-50 bg-[#111113] flex flex-col";

  const containerStyle: React.CSSProperties = {
    display: isOpen ? undefined : "none",
    ...(placement === "panel" ? { height: `${panelHeight * 100}vh` } : {}),
  };

  return (
    <div className={containerClass} style={containerStyle}>
      {/* Resize handle — only rendered in panel mode. The 8px target gives
          a comfortable grab area; the visible 2px line at the top edge of
          the panel matches the border. */}
      {placement === "panel" && (
        <div
          onMouseDown={beginResize}
          className="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize"
          title="Drag to resize"
        />
      )}
      <TerminalWorkspace
        appId={initialApp.id}
        appName={initialApp.name}
        rootDir={initialApp.root_dir}
        active={isOpen}
        pendingSession={pendingSession}
        onEmpty={onClose}
        onEscape={onClose}
        title={<span className="text-[12px] font-semibold text-zinc-200 font-mono">Terminal</span>}
        headerTrail={
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.07] transition-colors"
            title="Close"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        }
        tabStripTrail={
          <button
            onClick={() => setPlacement(placement === "modal" ? "panel" : "modal")}
            className="transition-colors hover:text-ink"
            title={placement === "modal" ? "Dock to bottom" : "Expand to full screen"}
          >
            {placement === "modal" ? (
              // Icon: bottom panel — outline rectangle with bottom band
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M1.5 9.5h12" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            ) : (
              // Icon: fullscreen — four corner arrows
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <path d="M2 5.5V2.5h3M13 5.5V2.5h-3M2 9.5v3h3M13 9.5v3h-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        }
      />
    </div>
  );
}
