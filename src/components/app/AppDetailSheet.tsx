import { useEffect } from "react";
import type { App, Workspace } from "../../types";

interface Props {
  app: App;
  workspace: Workspace | null;
  onClose: () => void;
  onOpenSettings?: () => void;
  onOpenTerminal?: () => void;
  onOpenDeploy?: () => void;
}

// ── Overview Tab ──────────────────────────────────────────────────────────────

function OverviewTab({ app, workspace, onOpenSettings, onOpenTerminal, onOpenDeploy }: {
  app: App;
  workspace: Workspace | null;
  onOpenSettings?: () => void;
  onOpenTerminal?: () => void;
  onOpenDeploy?: () => void;
}) {
  const domain = app.custom_domain || workspace?.domain || "narakarya.test";
  const sub = app.subdomain ?? app.name;
  const host = sub === "*" ? `*.${domain}` : `${sub}.${domain}`;

  return (
    <div className="flex flex-col gap-4 px-4 py-4 text-[12px]">
      {/* Status + name + port */}
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${
          app.status === "running"  ? "bg-emerald-400" :
          app.status === "starting" ? "bg-amber-400"   :
          "bg-zinc-600"
        }`} />
        <span className="text-zinc-100 font-semibold text-[14px]">{app.name}</span>
        <span className="text-zinc-500 font-mono ml-1">:{app.port}</span>
        <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium ${
          app.status === "running"  ? "bg-emerald-500/15 text-emerald-400" :
          app.status === "starting" ? "bg-amber-500/15 text-amber-400"   :
          "bg-zinc-700/40 text-zinc-500"
        }`}>
          {app.status}
        </span>
      </div>

      {/* Start command */}
      <Row label="Start command">
        <code className="text-zinc-300 font-mono text-[11px] break-all">{app.start_command || <span className="text-zinc-600 italic">not set</span>}</code>
      </Row>

      {/* Root dir */}
      <Row label="Root dir">
        <div className="flex items-center gap-1.5 min-w-0">
          <code className="text-zinc-400 font-mono text-[11px] truncate flex-1">{app.root_dir}</code>
        </div>
      </Row>

      {/* Subdomain / URL */}
      <Row label="URL">
        <span className="text-zinc-400 font-mono text-[11px]">{host}</span>
      </Row>

      {/* Port bindings (only shown if bindings exist) */}
      {app.port_bindings && app.port_bindings.length > 0 && (
        <Row label="Port bindings">
          <div className="flex flex-col gap-1">
            {app.port_bindings.map((b) => {
              const bDomain = b.custom_domain?.trim() || domain;
              const bSub = b.subdomain?.trim() || b.label.trim().toLowerCase().replace(/\s+/g, "-");
              const bHost = bSub ? `${bSub}.${bDomain}` : bDomain;
              return (
                <div key={b.id} className="flex items-center gap-2 text-[11px]">
                  <span className="text-zinc-300 font-medium min-w-[80px]">{b.label}</span>
                  <span className="text-zinc-500 font-mono truncate">{bHost}</span>
                  <span className="text-zinc-600">&rarr;</span>
                  <span className="text-zinc-400 font-mono">:{b.port}</span>
                </div>
              );
            })}
          </div>
        </Row>
      )}

      {/* Env file */}
      <Row label="Env file">
        {app.env_file ? (
          <code className="text-zinc-400 font-mono text-[11px]">{app.env_file}</code>
        ) : (
          <span className="text-zinc-600 italic">none</span>
        )}
      </Row>

      {/* Auto-start */}
      <Row label="Auto-start">
        <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${
          app.auto_start ? "bg-blue-500/15 text-blue-400" : "bg-zinc-700/30 text-zinc-500"
        }`}>
          {app.auto_start ? "enabled" : "disabled"}
        </span>
      </Row>

      {/* Deploy config (if present) */}
      {app.deploy_config_path && (
        <Row label="Deploy config">
          <code className="text-zinc-400 font-mono text-[11px] break-all">{app.deploy_config_path}</code>
        </Row>
      )}

      {/* Action buttons */}
      <div className="mt-2 flex flex-wrap gap-2">
        {onOpenTerminal && (
          <button
            onClick={onOpenTerminal}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.07] text-zinc-400 hover:text-zinc-200 text-[12px] transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M3.5 4.5L5.5 6L3.5 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M6.5 7.5h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            Terminal
          </button>
        )}
        {onOpenDeploy && app.deploy_config_path && (
          <button
            onClick={onOpenDeploy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.07] text-zinc-400 hover:text-zinc-200 text-[12px] transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1.5L9 5H7V9H5V5H3L6 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              <path d="M2 10.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            Deploy
          </button>
        )}
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.07] text-zinc-400 hover:text-zinc-200 text-[12px] transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11M2.3 2.3l1 1M8.7 8.7l1 1M8.7 2.3l-1 1M2.3 8.7l1-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            App Settings
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-zinc-600 uppercase tracking-wide font-medium">{label}</span>
      <div className="text-zinc-300">{children}</div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AppDetailSheet({ app, workspace, onClose, onOpenSettings, onOpenTerminal, onOpenDeploy }: Props) {
  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-30 bg-black/30"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-screen w-[420px] z-40 bg-[#161618] border-l border-white/[0.08] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.08] shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-semibold text-zinc-100 truncate">{app.name}</p>
            {workspace && (
              <p className="text-[11px] text-zinc-600 truncate">{workspace.name}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.07] transition-colors shrink-0"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <OverviewTab
            app={app}
            workspace={workspace}
            onOpenSettings={onOpenSettings}
            onOpenTerminal={onOpenTerminal}
            onOpenDeploy={onOpenDeploy}
          />
        </div>
      </div>
    </>
  );
}
