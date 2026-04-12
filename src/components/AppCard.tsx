import { usePortaStore } from "../store";
import type { App, Workspace } from "../types";

interface Props {
  app: App;
  workspace: Workspace | null;
}

function resolvedHost(app: App, workspace: Workspace | null): string {
  const domain = workspace?.domain ?? "narakarya.test";
  const sub = app.subdomain ?? app.name;
  return `${sub}.${domain}`;
}

export default function AppCard({ app, workspace }: Props) {
  const { startApp, stopApp, deleteApp } = usePortaStore();
  const host = resolvedHost(app, workspace);
  const isRunning = app.status === "running";

  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 rounded-lg bg-[#1c1c1e] border border-white/[0.06] hover:border-white/[0.10] transition-all duration-150">
      {/* Status dot */}
      <span
        className={`w-2 h-2 rounded-full shrink-0 transition-colors ${
          isRunning ? "bg-emerald-400 pulse-dot" : "bg-zinc-600"
        }`}
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-zinc-100 leading-tight">{app.name}</p>
        <p className="text-[11px] text-zinc-500 truncate mt-0.5">
          {host}
          <span className="text-zinc-700 ml-1">:{app.port}</span>
        </p>
      </div>

      {/* Actions — always visible on running, hover-only when stopped */}
      <div className={`flex items-center gap-1 transition-opacity duration-150 ${
        isRunning ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      }`}>
        {isRunning ? (
          <button
            onClick={() => stopApp(app.id)}
            className="px-2.5 py-1 text-[11px] font-medium text-zinc-300 bg-white/[0.07] hover:bg-white/[0.12] rounded-md transition-colors"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => startApp(app.id)}
            disabled={!app.start_command}
            className="px-2.5 py-1 text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md disabled:opacity-30 transition-colors"
          >
            Start
          </button>
        )}
        <a
          href={`http://${host}`}
          target="_blank"
          rel="noreferrer"
          className="px-2.5 py-1 text-[11px] font-medium text-zinc-400 bg-white/[0.07] hover:bg-white/[0.12] rounded-md transition-colors"
        >
          Open ↗
        </a>
        <button
          onClick={() => deleteApp(app.id)}
          className="p-1 text-zinc-600 hover:text-red-400 rounded-md transition-colors"
          title="Remove"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
