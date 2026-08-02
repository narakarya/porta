import { useCallback, useEffect, useMemo, useState } from "react";
import { usePortaStore } from "../../store";
import * as cmd from "../../lib/commands";
import type { RemoteContainerReport } from "../../lib/commands";
import { Spinner } from "../ui";

type Props = { sessionId: string; active: boolean };

/** Read-only Docker view for a remote host.
 *
 *  There is no start, stop, pull, prune or restart here, and that is the
 *  design rather than a milestone. Porta's Docker actions are built around the
 *  daemon being this laptop's — Caddy dials 127.0.0.1, volume snapshots
 *  bind-mount a local directory — so against a server the careful scoped
 *  operations quietly do nothing while the unscoped destructive ones work
 *  perfectly. The value that survives the trip is knowing what is behind. */
export default function RemoteDockerPanel({ sessionId, active }: Props) {
  const notifyError = usePortaStore((s) => s.notifyError);
  const notify = usePortaStore((s) => s.notify);

  const [rows, setRows] = useState<RemoteContainerReport[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await cmd.sshRemoteContainers(sessionId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Only on demand. Every call is `docker ps` plus a registry round trip per
  // distinct image, which is not something to run because a tab happened to
  // render.
  useEffect(() => {
    if (active && rows === null && !loading && !error) load();
  }, [active, rows, loading, error, load]);

  const projects = useMemo(() => {
    const groups = new Map<string, RemoteContainerReport[]>();
    for (const r of rows ?? []) {
      const key = r.project || "Standalone";
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  const behind = (r: RemoteContainerReport) =>
    r.update.status === "ok" && (r.update.has_digest_update || !!r.update.suggested_tag);

  async function copyPull(project: string) {
    // A command to paste, not a button to press. Running it from here would
    // mean Porta deciding to restart someone's production stack.
    const text =
      project === "Standalone"
        ? "docker pull <image> && docker restart <container>"
        : `docker compose -p ${project} pull && docker compose -p ${project} up -d`;
    try {
      await navigator.clipboard.writeText(text);
      notify({ kind: "success", message: "Command copied" });
    } catch (e) {
      notifyError("Couldn't copy the command", e);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle shrink-0">
        <span className="flex-1 min-w-0 text-[12px] text-ink-2">
          Docker on this host
          <span className="ml-2 text-[11px] text-ink-3">read-only</span>
        </span>
        <button
          onClick={load}
          disabled={loading}
          className="shrink-0 px-2 py-1 text-[11.5px] text-ink-3 hover:text-ink disabled:opacity-40 transition-colors"
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="m-3 px-2.5 py-2 bg-bad-bg border border-[var(--danger-border)] rounded-lg">
          <p className="text-[11.5px] text-bad break-words">{error}</p>
        </div>
      )}

      {loading && rows === null && (
        <div className="flex-1 flex items-center justify-center gap-2 text-[12px] text-ink-3">
          <Spinner size={12} />
          Reading containers and checking registries…
        </div>
      )}

      {rows !== null && rows.length === 0 && !loading && (
        <p className="px-3 py-4 text-[12px] text-ink-3">No containers are running on this host.</p>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
        {projects.map(([project, items]) => (
          <div key={project}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[11px] uppercase tracking-wide text-ink-3">{project}</span>
              {items.some(behind) && (
                <button
                  onClick={() => copyPull(project)}
                  title="Copy the update command to run yourself"
                  className="text-[10.5px] text-ink-3 hover:text-ink-2 transition-colors"
                >
                  copy update command
                </button>
              )}
            </div>

            <div className="border border-subtle rounded-card overflow-hidden">
              {items.map((r) => (
                <div
                  key={r.name}
                  className="flex items-center gap-2 px-2.5 py-1.5 border-b border-subtle last:border-b-0"
                >
                  <span
                    className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                      r.state === "running" ? "bg-ok" : "bg-ink-3"
                    }`}
                    title={r.status}
                  />
                  <span className="flex-1 min-w-0 flex flex-col leading-tight">
                    <span className="truncate text-[12.5px] text-ink">{r.name}</span>
                    <span className="truncate text-[11px] text-ink-3 font-mono mt-0.5">
                      {r.image}
                    </span>
                  </span>

                  <span className="shrink-0 text-right">
                    {r.update.status !== "ok" ? (
                      // Say why rather than showing a blank column — "needs
                      // credentials" and "digest-pinned" are different answers.
                      <span
                        className="text-[10.5px] text-ink-3"
                        title={r.update.message ?? undefined}
                      >
                        {r.update.status === "skipped" ? "not checked" : "check failed"}
                      </span>
                    ) : behind(r) ? (
                      <span className="flex flex-col items-end leading-tight">
                        <span className={`text-[11px] ${r.major_bump ? "text-bad" : "text-warn"}`}>
                          {r.update.suggested_tag
                            ? `${r.update.suggested_tag} available`
                            : "newer image"}
                        </span>
                        {/* A major bump is a different decision from a patch.
                            Rendering them identically is how someone upgrades
                            a database on a Friday. */}
                        {r.major_bump && (
                          <span className="text-[10px] text-bad mt-0.5">
                            major version — read the release notes
                          </span>
                        )}
                        {r.update.has_digest_update && r.update.suggested_tag && !r.major_bump && (
                          <span className="text-[10px] text-ink-3 mt-0.5">tag also re-pushed</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-[10.5px] text-ink-3">up to date</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}

        {rows !== null && rows.length > 0 && (
          <p className="text-[10.5px] text-ink-3 leading-snug">
            Porta only reads here. Updating a remote stack is a command you run yourself — its
            blast radius belongs to you, not to a button in a dev tool.
          </p>
        )}
      </div>
    </div>
  );
}
