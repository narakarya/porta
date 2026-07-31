import { useEffect, useState } from "react";
import {
  getTmuxStatus,
  installTmux,
  setKeepAppsRunningOnQuit,
  setTmuxSessionsEnabled,
  setTmuxTerminalEnabled,
  type TmuxStatus,
} from "../../lib/commands";

/**
 * Session hosting. Everything here hangs off one fact: without tmux, Porta owns
 * every process it starts, so quitting — including the restart an auto-update
 * performs — takes every dev server down with it. The copy says that plainly
 * rather than describing the toggles mechanically, because the toggles only
 * make sense once you know what they buy.
 */
export default function SessionsSection() {
  const [status, setStatus] = useState<TmuxStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  function load() {
    getTmuxStatus()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }
  useEffect(load, []);

  // Optimistic, with rollback: the write is a local JSON file, so a failure
  // means something is badly wrong and the checkbox must not keep lying.
  async function toggle(
    key: "sessionsEnabled" | "terminalEnabled" | "keepRunningOnQuit",
    write: (v: boolean) => Promise<void>
  ) {
    if (!status) return;
    const next = !status[key];
    setStatus({ ...status, [key]: next });
    setError("");
    try {
      await write(next);
    } catch (e) {
      setStatus({ ...status, [key]: !next });
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function install() {
    setInstalling(true);
    setError("");
    try {
      await installTmux();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  }

  if (!status) {
    return <div className="h-14 rounded-card bg-surface-1 border border-subtle animate-pulse" />;
  }

  const off = !status.installed;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[13px] font-semibold text-ink">Sessions</h2>
        <p className="text-[11px] text-ink-3 mt-0.5">
          Run apps and terminals inside tmux so they survive Porta restarting —
          including the restart an update performs.
        </p>
      </div>

      {off ? (
        <div className="rounded-card border border-subtle bg-surface-1 p-3 space-y-2">
          <p className="text-[12px] text-ink">tmux isn&apos;t installed</p>
          <p className="text-[11px] text-ink-3">
            Without it, an app&apos;s output is a pipe Porta holds open, so every
            running app stops when Porta quits or updates. Installing tmux moves
            them into sessions Porta can leave behind and pick back up.
          </p>
          <button
            onClick={install}
            disabled={installing}
            className="px-2.5 py-1 rounded text-[11px] bg-accent-bg border border-[rgba(96,165,250,0.3)] text-accent-ink hover:brightness-110 disabled:opacity-50 transition-colors"
          >
            {installing ? "Installing…" : "Install with Homebrew"}
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-ink-3 font-mono">{status.version}</p>
      )}

      <div className={off ? "opacity-40 pointer-events-none space-y-4" : "space-y-4"}>
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={status.keepRunningOnQuit}
            onChange={() => toggle("keepRunningOnQuit", setKeepAppsRunningOnQuit)}
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="text-[12px] text-ink">Keep apps running when Porta quits</span>
            <span className="block text-[11px] text-ink-3 mt-0.5">
              Quitting Porta stops being the same thing as stopping your apps.
              They keep serving, and Porta picks them back up — status, logs and
              all — the next time it starts. Stop, Force Kill and deleting an app
              still stop it immediately.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={status.sessionsEnabled}
            onChange={() => toggle("sessionsEnabled", setTmuxSessionsEnabled)}
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="text-[12px] text-ink">Host app processes in tmux</span>
            <span className="block text-[11px] text-ink-3 mt-0.5">
              Also gives apps a real terminal, so coloured output and progress
              bars survive. Applies to apps started from now on.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={status.terminalEnabled}
            onChange={() => toggle("terminalEnabled", setTmuxTerminalEnabled)}
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="text-[12px] text-ink">Host terminal panes in tmux</span>
            <span className="block text-[11px] text-ink-3 mt-0.5">
              A shell you leave running — and whatever is running in it — is
              still there after Porta restarts. Applies to panes opened from now
              on.
            </span>
          </span>
        </label>

        <div className="rounded-card border border-subtle bg-surface-1 p-3">
          <p className="text-[12px] text-ink">Reach a session from your own terminal</p>
          <p className="text-[11px] text-ink-3 mt-0.5">
            Sessions live on a private socket, so they never show up in a plain{" "}
            <span className="font-mono">tmux ls</span> and your own{" "}
            <span className="font-mono">tmux kill-server</span> can&apos;t touch
            them. List them with:
          </p>
          <p className="text-[11px] font-mono text-ink-2 mt-1.5 select-text break-all">
            tmux -L {status.socket} ls
          </p>
        </div>
      </div>

      {error && <p className="text-[12px] text-bad">{error}</p>}
    </div>
  );
}
