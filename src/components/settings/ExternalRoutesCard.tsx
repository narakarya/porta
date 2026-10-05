import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { listExternalRoutes, EXTERNAL_ROUTES_CHANGED } from "../../lib/commands";
import type { ExternalRoute, ExternalRoutesView } from "../../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Read-only list of the .test routes other tools (Kodera, …) hand to Porta.
 *  Renders nothing until a tool has registered a route or a file is broken. */
export default function ExternalRoutesCard() {
  const [view, setView] = useState<ExternalRoutesView | null>(null);

  useEffect(() => {
    const load = () => listExternalRoutes().then(setView).catch(() => {});
    load();
    if (!isTauri) return;
    const off = listen(EXTERNAL_ROUTES_CHANGED, load);
    return () => { void off.then((f) => f()); };
  }, []);

  if (!view || (view.routes.length === 0 && view.warnings.length === 0)) return null;

  const bySource = new Map<string, ExternalRoute[]>();
  for (const r of view.routes) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);

  return (
    <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
      {[...bySource].map(([source, routes]) => (
        <div key={source} className="flex flex-col gap-1.5">
          <p className="text-[13px] font-medium text-ink">External ({source})</p>
          {routes.map((r) => (
            <div key={r.host} className="flex justify-between gap-3 text-[11px]">
              <span className="font-mono text-ink-2 truncate">
                {r.host}
                {r.subdomains && <span className="text-ink-3"> + *.{r.host}</span>}
              </span>
              <span className="font-mono text-ink-3 shrink-0">127.0.0.1:{r.port}</span>
            </div>
          ))}
          {routes.flatMap((r) => r.skipped).map((h) => (
            <p key={h} className="text-[11px] text-warn">{h} is already routed by Porta or another tool, skipped</p>
          ))}
        </div>
      ))}
      {view.warnings.map((w) => (
        <p key={w} className="text-[11px] text-warn">{w}</p>
      ))}
      <p className="text-[11px] text-ink-3 font-mono">{view.dir}</p>
    </div>
  );
}
