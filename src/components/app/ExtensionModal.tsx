import { useCallback, useEffect, useRef, useState } from "react";
import ExtensionPanel from "./ExtensionPanel";
import { ExtensionIcon } from "../extension/ExtensionIcon";
import type { ExtensionInfo } from "../../types/extension";
import type { App } from "../../types";

interface Props {
  app: App;
  extension: ExtensionInfo;
  onClose: () => void;
}

export default function ExtensionModal({ app, extension, onClose }: Props) {
  const [title, setTitle] = useState(extension.name);
  const [toast, setToast] = useState<{ msg: string; kind: "info" | "success" | "error" } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const toastTimer = useRef<number | null>(null);

  const handleToast = useCallback((msg: string, kind: "info" | "success" | "error") => {
    setToast({ msg, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  const handleReload = useCallback(() => {
    setTitle(extension.name);
    setReloadKey((key) => key + 1);
    handleToast("Extension reloaded", "success");
  }, [extension.name, handleToast]);

  // Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-[#0a0a0c]/95 backdrop-blur-sm z-50 flex flex-col overflow-hidden"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex flex-col flex-1 m-4 md:m-8 bg-[#1c1c1e] border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.07] shrink-0 select-none">
          <ExtensionIcon extension={extension} size="sm" />

          <div className="flex flex-col">
            <span className="text-[13px] font-semibold text-zinc-200 leading-tight">{title}</span>
            <span className="text-[10px] text-zinc-600 leading-tight">{app.name} · {extension.version}</span>
          </div>

          <div className="flex-1" />

          <button
            onClick={handleReload}
            className="p-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
            title="Reload extension"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M13 8a5 5 0 1 1-1.7-3.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M13 2v4h-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          <button
            onClick={onClose}
            className="p-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
            title="Close (Esc)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Extension panel */}
        <ExtensionPanel
          app={app}
          extension={extension}
          reloadKey={reloadKey}
          onTitleChange={setTitle}
          onToast={handleToast}
        />
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] shadow-lg ${
          toast.kind === "success"
            ? "bg-zinc-800 border-emerald-500/30 text-emerald-400"
            : toast.kind === "error"
            ? "bg-zinc-800 border-red-500/30 text-red-400"
            : "bg-zinc-800 border-blue-500/30 text-blue-300"
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
