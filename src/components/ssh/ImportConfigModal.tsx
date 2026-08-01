import { useEffect, useMemo, useState } from "react";
import { usePortaStore } from "../../store";
import * as cmd from "../../lib/commands";
import type { SshConfigCandidate } from "../../lib/commands";
import { Spinner } from "../ui";

type Props = { onClose: () => void };

/** Pick hosts out of `~/.ssh/config` and add them to the vault.
 *
 *  Entries already in the vault stay listed but unselectable — hiding them
 *  would make a re-scan after adding one host look like the parser had missed
 *  the other twenty. */
export default function ImportConfigModal({ onClose }: Props) {
  const importSshConfigHosts = usePortaStore((s) => s.importSshConfigHosts);
  const notify = usePortaStore((s) => s.notify);
  const notifyError = usePortaStore((s) => s.notifyError);

  const [candidates, setCandidates] = useState<SshConfigCandidate[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    cmd
      .sshScanConfig()
      .then((found) => {
        if (cancelled) return;
        setCandidates(found);
        // Pre-select everything importable: the common case is a first run on a
        // config the user already trusts, and ticking 20 boxes is busywork.
        setPicked(new Set(found.filter((c) => !c.already_in_vault).map((c) => c.alias)));
      })
      .catch((e) => {
        if (!cancelled) setScanError(e instanceof Error ? e.message : String(e));
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

  const importable = useMemo(
    () => (candidates ?? []).filter((c) => !c.already_in_vault),
    [candidates]
  );
  const allPicked = importable.length > 0 && picked.size === importable.length;

  function toggle(alias: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(alias)) next.add(alias);
      return next;
    });
  }

  async function run() {
    setImporting(true);
    try {
      // Global (no workspace attachment) — a config file has no notion of
      // Porta workspaces, and guessing one would hide the imported hosts
      // behind a filter the user never set.
      const created = await importSshConfigHosts([...picked], []);
      notify({
        kind: "success",
        message: `Imported ${created.length} host${created.length === 1 ? "" : "s"} from ~/.ssh/config`,
      });
      onClose();
    } catch (e) {
      notifyError("Couldn't import from ~/.ssh/config", e);
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
          <div className="text-[14px] text-ink font-semibold">Import from ~/.ssh/config</div>
          <p className="text-[11px] text-ink-3 mt-0.5">
            Reads HostName, User, Port, IdentityFile and ProxyJump. Your config file isn't modified.
          </p>
        </div>

        {scanError && (
          <div className="px-2.5 py-2 bg-bad-bg border border-[var(--danger-border)] rounded-lg">
            <p className="text-[11px] text-bad break-words">{scanError}</p>
          </div>
        )}

        {candidates === null && !scanError && (
          <div className="flex items-center gap-2 py-6 justify-center text-[12px] text-ink-3">
            <Spinner size={12} />
            Reading ~/.ssh/config…
          </div>
        )}

        {candidates?.length === 0 && (
          <p className="py-6 text-center text-[12px] text-ink-3">
            No host entries found in ~/.ssh/config.
          </p>
        )}

        {candidates && candidates.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-ink-3">
                {importable.length} new · {candidates.length - importable.length} already in vault
              </span>
              {importable.length > 0 && (
                <button
                  className="text-[11px] text-ink-2 hover:text-ink transition-colors"
                  onClick={() =>
                    setPicked(allPicked ? new Set() : new Set(importable.map((c) => c.alias)))
                  }
                >
                  {allPicked ? "Select none" : "Select all"}
                </button>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-0.5">
              {candidates.map((c) => {
                const on = picked.has(c.alias);
                const dup = c.already_in_vault;
                return (
                  <button
                    key={c.alias}
                    type="button"
                    disabled={dup}
                    onClick={() => toggle(c.alias)}
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
                        <span className="truncate text-[12.5px] text-ink">{c.alias}</span>
                        {dup && <span className="shrink-0 text-[10px] text-ink-3">in vault</span>}
                      </span>
                      <span className="truncate text-[11px] text-ink-3 mt-0.5">
                        {c.username}@{c.hostname}
                        {c.port !== 22 && `:${c.port}`}
                        {c.proxy_jump && ` · via ${c.proxy_jump}`}
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
            {importing ? "Importing…" : `Import ${picked.size || ""}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
