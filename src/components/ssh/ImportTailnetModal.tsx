import { useEffect, useMemo, useState } from "react";
import { usePortaStore } from "../../store";
import * as cmd from "../../lib/commands";
import type { TailscalePeer } from "../../lib/commands";
import { Spinner } from "../ui";

type Props = { onClose: () => void };

/** Add machines from the tailnet to the host vault.
 *
 *  Tailscale already knows every machine you can reach; retyping their
 *  addresses into a form is the kind of work a tool should not ask for. What it
 *  does not know is who you are on them, so the username is a guess the user
 *  can correct — same trade-off the ~/.ssh/config import makes. */
export default function ImportTailnetModal({ onClose }: Props) {
  const loadSshHosts = usePortaStore((s) => s.loadSshHosts);
  const notify = usePortaStore((s) => s.notify);
  const notifyError = usePortaStore((s) => s.notifyError);

  const [peers, setPeers] = useState<TailscalePeer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    cmd
      .tailscalePeers()
      .then((found) => {
        if (cancelled) return;
        setPeers(found);
        // Pre-select the reachable ones only. A sleeping machine is worth
        // listing, but ticking it by default invites a vault full of hosts the
        // user can't connect to today.
        setPicked(
          new Set(found.filter((p) => !p.alreadyInVault && p.online).map((p) => p.hostname))
        );
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const importable = useMemo(() => (peers ?? []).filter((p) => !p.alreadyInVault), [peers]);

  function toggle(hostname: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(hostname)) next.add(hostname);
      return next;
    });
  }

  async function run() {
    setImporting(true);
    try {
      const created = await cmd.tailscaleImportHosts([...picked], []);
      await loadSshHosts();
      notify({
        kind: "success",
        message: `Added ${created.length} host${created.length === 1 ? "" : "s"} from the tailnet`,
      });
      onClose();
    } catch (e) {
      notifyError("Couldn't import from Tailscale", e);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="w-[26rem] max-h-[85vh] flex flex-col p-4 bg-surface-2 border border-subtle rounded-xl gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <div className="text-[14px] text-ink font-semibold">Add from Tailscale</div>
          <p className="text-[11px] text-ink-3 mt-0.5">
            Machines on your tailnet. Porta uses their MagicDNS name and guesses your local
            username — edit the host afterwards if it differs.
          </p>
        </div>

        {error && (
          <div className="px-2.5 py-2 bg-bad-bg border border-[var(--danger-border)] rounded-lg">
            <p className="text-[11px] text-bad break-words">{error}</p>
          </div>
        )}

        {peers === null && !error && (
          <div className="flex items-center gap-2 py-6 justify-center text-[12px] text-ink-3">
            <Spinner size={12} />
            Asking Tailscale…
          </div>
        )}

        {peers?.length === 0 && (
          <p className="py-6 text-center text-[12px] text-ink-3">
            No other machines on this tailnet.
          </p>
        )}

        {peers && peers.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-ink-3">
                {importable.length} new · {peers.length - importable.length} already in vault
              </span>
              {importable.length > 0 && (
                <button
                  className="text-[11px] text-ink-2 hover:text-ink transition-colors"
                  onClick={() =>
                    setPicked(
                      picked.size === importable.length
                        ? new Set()
                        : new Set(importable.map((p) => p.hostname))
                    )
                  }
                >
                  {picked.size === importable.length ? "Select none" : "Select all"}
                </button>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-0.5">
              {peers.map((p) => {
                const on = picked.has(p.hostname);
                const dup = p.alreadyInVault;
                return (
                  <button
                    key={p.hostname}
                    type="button"
                    disabled={dup}
                    onClick={() => toggle(p.hostname)}
                    className={`w-full flex items-start gap-2.5 px-2 py-1.5 rounded-md text-left transition-colors ${
                      dup ? "opacity-45" : "hover:bg-white/[0.05]"
                    }`}
                  >
                    <span
                      className={`mt-0.5 w-3.5 h-3.5 shrink-0 rounded border flex items-center justify-center ${
                        on && !dup ? "bg-accent border-[var(--accent)]" : "border-white/[0.2]"
                      }`}
                    >
                      {on && !dup && (
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                          <path
                            d="M1.5 4l1.5 1.5L6.5 2"
                            stroke="#fff"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </span>
                    <span className="flex-1 min-w-0 flex flex-col leading-tight">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                            p.online ? "bg-ok" : "bg-ink-3"
                          }`}
                          title={p.online ? "Online" : "Offline"}
                        />
                        <span className="truncate text-[12.5px] text-ink">{p.label}</span>
                        {dup && <span className="shrink-0 text-[10px] text-ink-3">in vault</span>}
                      </span>
                      <span className="truncate text-[11px] text-ink-3 font-mono mt-0.5">
                        {p.hostname}
                        {p.os && <span className="font-sans"> · {p.os}</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            className="ml-auto px-3 py-1.5 text-[12px] text-ink-2 hover:text-ink transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-[12px] font-medium bg-accent text-white rounded-lg disabled:opacity-40 transition-colors"
            disabled={picked.size === 0 || importing}
            onClick={run}
          >
            {importing ? "Adding…" : `Add ${picked.size || ""}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
