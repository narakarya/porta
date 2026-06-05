import { useState } from "react";
import Tooltip from "../shared/Tooltip";
import { useExtensionInvoke } from "./ExtensionHostManager";
import type { App } from "../../types";
import type { ExtensionInfo, ExtensionActionContrib } from "../../types/extension";

// Preset action icons (porta.json `contributes.appActions[].icon`).
function ActionIcon({ name }: { name?: string }) {
  const p = { width: 12, height: 12, viewBox: "0 0 12 12", fill: "none" as const };
  switch (name) {
    case "terminal":
      return <svg {...p}><path d="M2 3l3 3-3 3M6.5 9h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "rocket":
      return <svg {...p}><path d="M6 1.5c2 1 3 3 2.5 6l-2.5 1-2.5-1C3 4.5 4 2.5 6 1.5zM6 5.5v.01M4.5 8.5L3 10.5M7.5 8.5L9 10.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "gear":
      return <svg {...p}><circle cx="6" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.1" /><path d="M6 1.5v1.2M6 9.3v1.2M1.5 6h1.2M9.3 6h1.2M2.8 2.8l.9.9M8.3 8.3l.9.9M9.2 2.8l-.9.9M3.7 8.3l-.9.9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></svg>;
    case "key":
      return <svg {...p}><circle cx="4" cy="8" r="2" stroke="currentColor" strokeWidth="1.1" /><path d="M5.4 6.6L10 2M8 4l1.2 1.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>;
    case "search":
      return <svg {...p}><circle cx="5" cy="5" r="3" stroke="currentColor" strokeWidth="1.1" /><path d="M7.5 7.5L10.5 10.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>;
    case "refresh":
      return <svg {...p}><path d="M9.5 4A4 4 0 1 0 10 6M9.5 1.5V4H7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "box":
    default:
      return <svg {...p}><path d="M6 1.5l4 2v5l-4 2-4-2v-5l4-2zM2 3.5l4 2 4-2M6 5.5V10.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
}

function Spinner() {
  return (
    <svg className="animate-spin" width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 1A5 5 0 1 1 1 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

interface Pair {
  extension: ExtensionInfo;
  action: ExtensionActionContrib;
}

/**
 * Inline buttons on an app card for every appAction contributed by an enabled
 * extension matching this app. Clicking runs the command headlessly via the
 * extension host — no need to open the full panel.
 */
export default function ExtensionActionButtons({
  app,
  extensions,
  onOpenExtension,
}: {
  app: App;
  extensions: ExtensionInfo[];
  /** Fallback when an action isn't a registered command — open its full panel. */
  onOpenExtension: (extension: ExtensionInfo) => void;
}) {
  const { invokeAction } = useExtensionInvoke();
  const [busy, setBusy] = useState<string | null>(null);

  const pairs: Pair[] = extensions
    .filter((e) => e.enabled)
    .flatMap((e) => (e.contributes_app_actions ?? []).map((action) => ({ extension: e, action })));

  if (pairs.length === 0) return null;

  async function run(p: Pair) {
    const k = `${p.extension.id}:${p.action.id}`;
    if (busy) return;
    setBusy(k);
    try {
      await invokeAction(app, p.extension, p.action.id);
    } catch (e) {
      // No command registered for this action → open the extension's panel.
      if (e instanceof Error && e.message === "__unregistered__") {
        onOpenExtension(p.extension);
      }
      // Other errors were already surfaced as a toast by the host.
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {pairs.map((p) => {
        const k = `${p.extension.id}:${p.action.id}`;
        const isBusy = busy === k;
        return (
          <Tooltip key={k} label={p.action.tooltip || `${p.action.label} · ${p.extension.name}`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void run(p);
              }}
              disabled={!!busy}
              aria-label={`${p.action.label} (${p.extension.name})`}
              className="flex items-center gap-1 px-1.5 py-1 rounded-md text-[11px] text-zinc-500 hover:text-violet-300 hover:bg-violet-500/10 disabled:opacity-50 transition-colors"
            >
              {isBusy ? <Spinner /> : <ActionIcon name={p.action.icon} />}
              <span className="max-w-[88px] truncate">{p.action.label}</span>
            </button>
          </Tooltip>
        );
      })}
    </>
  );
}
