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

  const statusDot: Record<string, string> = {
    running: "bg-green-400",
    stopped: "bg-gray-500",
    error: "bg-red-400",
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center gap-4">
      <span
        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
          statusDot[app.status] ?? "bg-gray-500"
        }`}
      />

      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm text-gray-100">{app.name}</p>
        <p className="text-xs text-gray-400 truncate">
          {host} <span className="text-gray-600">:{app.port}</span>
        </p>
      </div>

      <div className="flex items-center gap-2">
        {app.status === "running" ? (
          <button
            onClick={() => stopApp(app.id)}
            className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 rounded-md transition-colors"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => startApp(app.id)}
            disabled={!app.start_command}
            className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-md transition-colors"
          >
            Start
          </button>
        )}
        <a
          href={`http://${host}`}
          target="_blank"
          rel="noreferrer"
          className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 rounded-md transition-colors"
        >
          Open
        </a>
        <button
          onClick={() => deleteApp(app.id)}
          className="px-2 py-1 text-xs text-gray-500 hover:text-red-400 rounded-md transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
