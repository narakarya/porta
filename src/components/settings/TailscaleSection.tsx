import { useCallback, useEffect, useState } from "react";
import {
  getTailscaleStatus,
  listTailscaleServes,
  resetTailscaleServes,
  stopAllPortaTailscaleServes,
  type TailscaleStatus,
  type TailscaleServeEntry,
} from "../../lib/commands";
import {
  getCachedTailscaleStatus,
  setCachedTailscaleStatus,
  getCachedTailscaleServes,
  setCachedTailscaleServes,
} from "../../lib/tailscaleCache";
import { usePortaStore } from "../../store";

/** Global Tailscale management — install/login status, active serves, reset. */
export default function TailscaleSection() {
  const { apps } = usePortaStore();
  // Hydrate from cache so tab switch doesn't flash an empty state — a fresh
  // fetch runs immediately after.
  const [status, setStatus] = useState<TailscaleStatus | null>(() => getCachedTailscaleStatus());
  const [serves, setServes] = useState<TailscaleServeEntry[]>(() => getCachedTailscaleServes());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);
  // Remember whether the last user-triggered recheck produced the same status
  // as before — surfaces a helpful hint when clicking "Check again" feels like
  // nothing happened.
  const [recheckedWithoutChange, setRecheckedWithoutChange] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const refresh = useCallback(async (userTriggered = false) => {
    // Snapshot previous state outside the setter so we can diff after fetch.
    const prev = getCachedTailscaleStatus();
    setLoading(true);
    setError(null);
    try {
      const st = await getTailscaleStatus();
      setStatus(st);
      setCachedTailscaleStatus(st);
      if (userTriggered && prev) {
        const same = prev.installed === st.installed
          && prev.running === st.running
          && prev.logged_in === st.logged_in;
        setRecheckedWithoutChange(same);
      } else {
        setRecheckedWithoutChange(false);
      }
      if (st.installed && st.running && st.logged_in) {
        const list = await listTailscaleServes();
        setServes(list);
        setCachedTailscaleServes(list);
      } else {
        setServes([]);
        setCachedTailscaleServes([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh every 30s so enabling Funnel in the admin console or running
  // manual `tailscale serve` commands reflect without the user clicking Refresh.
  // Pauses when the tab/window is hidden to avoid wasted work.
  useEffect(() => {
    let intervalId: number | undefined;
    function startInterval() {
      if (intervalId !== undefined) return;
      intervalId = window.setInterval(refresh, 30_000);
    }
    function stopInterval() {
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        refresh();
        startInterval();
      } else {
        stopInterval();
      }
    }
    if (document.visibilityState === "visible") startInterval();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopInterval();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  function copyCmd(cmd: string) {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 1500);
    });
  }

  async function handleReset() {
    setResetting(true);
    setError(null);
    try {
      await resetTailscaleServes();
      setConfirmReset(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  }

  async function handleStopAllPorta() {
    setStoppingAll(true);
    setError(null);
    try {
      await stopAllPortaTailscaleServes();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStoppingAll(false);
    }
  }

  // Match serves to apps by port so we can label each entry.
  const serveWithApp = serves.map((s) => {
    const app = apps.find((a) => a.port === s.port);
    return { ...s, appName: app?.name ?? null, appId: app?.id ?? null };
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[16px] font-semibold text-zinc-100">Tailscale</h1>
          <p className="text-[12px] text-zinc-500 mt-0.5">
            Private access via your tailnet, or public via Funnel. No domain setup required.
          </p>
        </div>
        <button
          onClick={() => refresh()}
          disabled={loading}
          className="text-[10px] text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-50"
        >
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      {error && (
        <div className="relative px-3 py-2 pr-14 rounded-lg bg-red-500/10 border border-red-500/30 text-[11px] text-red-300 font-mono whitespace-pre-wrap break-words">
          {error}
          <button
            onClick={() => setError(null)}
            className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] rounded bg-red-500/20 hover:bg-red-500/30 text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Install state */}
      {status && !status.installed && (
        <div className="flex flex-col gap-3 px-3 py-3 rounded-xl bg-amber-500/[0.06] border border-amber-500/20">
          <p className="text-[12px] text-amber-300">Tailscale not found.</p>
          <p className="text-[11px] text-amber-200/70 leading-relaxed">
            Download from <span className="font-mono">tailscale.com/download</span> or install via Homebrew:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] font-mono bg-black/30 px-2.5 py-1.5 rounded">
              brew install tailscale
            </code>
            <button
              onClick={() => copyCmd("brew install tailscale")}
              className="px-2.5 py-1.5 text-[10px] font-medium rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 transition-colors"
              style={{ color: copiedCmd === "brew install tailscale" ? "#a3e635" : undefined }}
            >
              {copiedCmd === "brew install tailscale" ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => refresh(true)}
            disabled={loading}
            className="self-start flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium rounded-md bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            ) : "↻"}
            {loading ? "Checking…" : "Check again"}
          </button>
          {recheckedWithoutChange && (
            <p className="text-[10px] text-amber-300/80 leading-snug">
              Still not finding the CLI. Try restarting Porta after install, or check <span className="font-mono">which tailscale</span> in a terminal.
            </p>
          )}
        </div>
      )}

      {/* Login state */}
      {status && status.installed && (!status.running || !status.logged_in) && (
        <div className="flex flex-col gap-3 px-3 py-3 rounded-xl bg-amber-500/[0.06] border border-amber-500/20">
          <p className="text-[12px] text-amber-300">
            {!status.running ? "Tailscale daemon not running." : "Not logged in."}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] font-mono bg-black/30 px-2.5 py-1.5 rounded">
              tailscale up
            </code>
            <button
              onClick={() => copyCmd("tailscale up")}
              className="px-2.5 py-1.5 text-[10px] font-medium rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 transition-colors"
              style={{ color: copiedCmd === "tailscale up" ? "#a3e635" : undefined }}
            >
              {copiedCmd === "tailscale up" ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => refresh(true)}
            disabled={loading}
            className="self-start flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium rounded-md bg-amber-500/15 hover:bg-amber-500/25 text-amber-200 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            ) : "↻"}
            {loading
              ? "Checking…"
              : !status.running ? "I've started it" : "I'm logged in"}
          </button>
          {recheckedWithoutChange && (
            <p className="text-[10px] text-amber-300/80 leading-snug">
              {!status.running
                ? "Daemon still stopped. Open the Tailscale app from your menu bar and wait for the status to show 'Connected'."
                : "Still not logged in. Running `tailscale up` should open a browser — make sure you completed the auth flow there."}
            </p>
          )}
        </div>
      )}

      {/* Connected state */}
      {status && status.installed && status.running && status.logged_in && (
        <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[11px] text-emerald-300">
              Connected as <span className="font-mono">{status.host ?? "(unknown)"}</span>
            </span>
          </div>
        </div>
      )}

      {/* Active serves */}
      {status?.installed && status?.running && status?.logged_in && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wide">Active Serves</p>
            <span className="text-[10px] text-zinc-600">{serves.length} entries</span>
          </div>
          {serves.length === 0 && !loading && (
            <p className="text-[11px] text-zinc-600 italic">No serves active. Start one from an app's Tunneling tab.</p>
          )}
          <div className="flex flex-col gap-2">
            {serveWithApp.map((s) => (
              <div
                key={`${s.port}-${s.upstream}`}
                className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]"
              >
                <div className={`shrink-0 w-2 h-2 rounded-full mt-1.5 ${s.funnel ? "bg-orange-400" : "bg-emerald-400"}`} title={s.funnel ? "Public (Funnel)" : "Private (Serve)"} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-[12px] font-medium text-zinc-200 truncate">
                      {s.appName ?? `Port ${s.port}`}
                    </p>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${s.funnel ? "bg-orange-500/15 text-orange-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                      {s.funnel ? "PUBLIC" : "TAILNET"}
                    </span>
                  </div>
                  <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                    :{s.port} → {s.upstream}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stop Porta-managed serves — safe bulk disconnect */}
      {status?.installed && serves.length > 0 && (
        <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <div>
            <p className="text-[11px] font-medium text-zinc-200">Stop all Porta tunnels</p>
            <p className="text-[10px] text-zinc-500 leading-relaxed mt-0.5">
              Disconnects every Tailscale tunnel Porta started. Manual entries you set up outside Porta are left alone.
            </p>
          </div>
          <button
            onClick={handleStopAllPorta}
            disabled={stoppingAll}
            className="shrink-0 px-3 py-1.5 text-[11px] font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 rounded-lg disabled:opacity-50 transition-colors"
          >
            {stoppingAll ? "Stopping…" : "Stop all"}
          </button>
        </div>
      )}

      {/* Reset all — destructive escape hatch */}
      {status?.installed && serves.length > 0 && (
        <div className="flex flex-col gap-2 p-3 rounded-xl bg-red-500/[0.04] border border-red-500/20 mt-2">
          <p className="text-[11px] font-medium text-red-300">Reset all serves</p>
          <p className="text-[10px] text-zinc-500 leading-relaxed">
            Removes every Tailscale Serve and Funnel entry on this machine — including any you set up outside of Porta.
          </p>
          {!confirmReset ? (
            <button
              onClick={() => setConfirmReset(true)}
              className="self-start px-3 py-1.5 text-[11px] font-medium bg-red-500/10 hover:bg-red-500/20 text-red-300 rounded-lg transition-colors"
            >
              Reset all…
            </button>
          ) : (
            <div className="flex gap-2 items-center">
              <span className="text-[11px] text-zinc-300">Are you sure?</span>
              <button
                onClick={() => setConfirmReset(false)}
                className="px-3 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleReset}
                disabled={resetting}
                className="px-3 py-1.5 text-[11px] font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg disabled:opacity-50 transition-colors"
              >
                {resetting ? "Resetting…" : "Yes, reset all"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
