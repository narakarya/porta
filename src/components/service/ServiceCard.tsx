import { lazy, memo, Suspense, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePortaStore } from "../../store";
import type { Service } from "../../types";

const ServiceSettingsModal = lazy(() => import("./ServiceSettingsModal"));

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

interface Props { service: Service; }

function ServiceCard({ service }: Props) {
  const { startService, stopService, restartService, clearServiceLogs } = usePortaStore(
    useShallow((s) => ({
      startService: s.startService,
      stopService: s.stopService,
      restartService: s.restartService,
      clearServiceLogs: s.clearServiceLogs,
    }))
  );
  const serviceLog = usePortaStore((s) => s.serviceLogs[service.id]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectCopied, setConnectCopied] = useState(false);

  /**
   * Pick a CLI client to recommend for `docker exec` based on the image
   * name. The match is loose (substring) so `postgres:16`,
   * `bitnami/postgresql`, and `pgvector/pgvector` all hit the postgres
   * branch.
   *
   * Returns null for images we don't recognise; the Connect button only
   * appears when this is non-null, so the user isn't tempted to click
   * something that'd just open a bash shell.
   *
   * Order matters — `valkey` must come before `redis` since valkey images
   * sometimes carry the word "redis" in their tag, and we want the
   * dedicated `valkey-cli` path first.
   */
  function connectCommand(): string | null {
    if (!service.container_id) return null;
    const c = `porta-${service.id}`;
    const img = service.image.toLowerCase();

    if (img.includes("postgres") || img.includes("postgis") || img.includes("pgvector")) {
      return `docker exec -it ${c} psql -U postgres`;
    }
    if (img.includes("mariadb")) return `docker exec -it ${c} mariadb -u root`;
    if (img.includes("mysql"))   return `docker exec -it ${c} mysql -u root`;
    if (img.includes("valkey"))  return `docker exec -it ${c} valkey-cli`;
    if (img.includes("dragonfly")) return `docker exec -it ${c} redis-cli`;
    if (img.includes("redis"))   return `docker exec -it ${c} redis-cli`;
    if (img.includes("mongo"))   return `docker exec -it ${c} mongosh`;
    if (img.includes("rabbitmq")) return `docker exec -it ${c} rabbitmqctl status`;
    if (img.includes("clickhouse")) return `docker exec -it ${c} clickhouse-client`;
    if (img.includes("etcd"))     return `docker exec -it ${c} etcdctl get / --prefix --keys-only`;
    if (img.includes("nats"))     return `docker exec -it ${c} nats stream ls`;
    if (img.includes("cassandra")) return `docker exec -it ${c} cqlsh`;
    if (img.includes("scylla"))   return `docker exec -it ${c} cqlsh`;
    if (img.includes("influxdb")) return `docker exec -it ${c} influx`;
    if (img.includes("neo4j"))    return `docker exec -it ${c} cypher-shell -u neo4j`;
    // HTTP-based services — copy a curl probe instead of an interactive
    // shell. Reading the live indexes/buckets/health beats `bash` for the
    // 90% case of "is it actually responding?"
    if (img.includes("elasticsearch") || img.includes("opensearch")) {
      return `curl -s http://localhost:${service.port}/_cat/indices?v`;
    }
    if (img.includes("meilisearch")) return `curl -s http://localhost:${service.port}/indexes`;
    if (img.includes("typesense"))   return `curl -s http://localhost:${service.port}/collections`;
    if (img.includes("qdrant"))      return `curl -s http://localhost:${service.port}/collections`;
    if (img.includes("minio"))       return `curl -s http://localhost:${service.port}/minio/health/live`;
    return null;
  }
  const cmd = connectCommand();

  function copyConnectCommand() {
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => {
      setConnectCopied(true);
      setTimeout(() => setConnectCopied(false), 1800);
    });
  }

  const isRunning = service.status === "running";
  const isPulling = service.status === "pulling";
  const isStarting = service.status === "starting";
  const isActive = isRunning || isPulling || isStarting;

  const logs = serviceLog ?? [];

  const dotColor =
    isRunning  ? "bg-emerald-400" :
    isPulling  ? "bg-blue-400 animate-pulse" :
    isStarting ? "bg-amber-400 animate-pulse" :
    "bg-zinc-600";

  const connString = `localhost:${service.port}`;

  function copyConn() {
    navigator.clipboard.writeText(connString).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <>
      <div
        className="group flex flex-col rounded-xl border bg-[#1a1a1c] border-white/[0.07] hover:border-white/[0.12] transition-all duration-150 cursor-pointer"
        onClick={() => setSettingsOpen(true)}
      >
        {/* Main row */}
        <div className="flex items-center gap-3 px-3.5 py-3">
          {/* Status dot */}
          <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />

          {/* Name + image */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-[13px] font-medium text-zinc-100 leading-tight truncate">{service.name}</p>
              {service.scope !== "global" && (
                <span className="text-[9px] font-medium text-zinc-600 bg-white/[0.04] border border-white/[0.06] px-1.5 py-0.5 rounded shrink-0">ws</span>
              )}
            </div>
            <p className="text-[11px] text-zinc-600 mt-0.5 font-mono truncate">
              {service.image}:{service.tag}
            </p>
          </div>

          {/* Connection string (always visible when running, hover otherwise) */}
          {isRunning ? (
            <button
              onClick={(e) => { e.stopPropagation(); copyConn(); }}
              title="Copy connection string"
              className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-500/8 border border-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15 transition-colors"
            >
              <span className="text-[11px] font-mono">{connString}</span>
              {copied ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M1.5 5l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="3.5" y="1" width="5.5" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.1"/>
                  <path d="M1 3.5v5A1 1 0 002 9.5h4.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                </svg>
              )}
            </button>
          ) : (
            <span className="text-[11px] text-zinc-700 font-mono opacity-0 group-hover:opacity-100 transition-opacity">
              :{service.port}
            </span>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* Logs button */}
            {logs.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); setLogsOpen(true); }}
                className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.07] rounded-lg transition-colors"
                title="View logs"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="1.5" y="1" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M4 4h4M4 6h4M4 8h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </button>
            )}
            {/* Connect button — copies the appropriate `docker exec` CLI
                command for the recognized service kind. Hidden when the
                container isn't running or the image is unknown. */}
            {isRunning && cmd && (
              <button
                onClick={(e) => { e.stopPropagation(); copyConnectCommand(); }}
                title={connectCopied ? "Copied!" : `Copy: ${cmd}`}
                className="p-1.5 text-zinc-500 hover:text-emerald-300 hover:bg-emerald-500/10 rounded-lg transition-colors"
              >
                {connectCopied ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6l3 3 5-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M3 2h7a1 1 0 011 1v7M2 3v8a1 1 0 001 1h7M5 5l-2 2 2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            )}
          </div>

          {/* Start / Stop / Restart */}
          <div className={`flex items-center gap-1 transition-opacity ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            {isActive ? (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); restartService(service.id); }}
                  disabled={isPulling || isStarting}
                  className="px-2.5 py-1 text-[11px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors disabled:opacity-40"
                  title="Restart this service"
                >
                  Restart
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); stopService(service.id); }}
                  disabled={isPulling || isStarting}
                  className="px-2.5 py-1 text-[11px] font-medium text-zinc-300 bg-white/[0.07] hover:bg-white/[0.12] rounded-lg transition-colors disabled:opacity-40"
                >
                  Stop
                </button>
              </>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); startService(service.id); }}
                className="px-2.5 py-1 text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-lg transition-colors"
              >
                Start
              </button>
            )}
          </div>
        </div>

        {/* Progress bar during pull/start */}
        {(isPulling || isStarting) && (
          <div className="mx-3.5 mb-3 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05]">
            <span className="w-3 h-3 border border-zinc-600 border-t-transparent rounded-full animate-spin shrink-0" />
            <span className="text-[11px] text-zinc-500">
              {isPulling ? `Pulling ${service.image}:${service.tag}…` : "Starting container…"}
            </span>
          </div>
        )}

        {/* Live log tail — last 2 lines when running */}
        {isRunning && logs.length > 0 && (
          <div
            className="mx-3.5 mb-3 px-2.5 py-1.5 rounded-lg bg-black/30 border border-white/[0.04] cursor-pointer"
            onClick={(e) => { e.stopPropagation(); setLogsOpen(true); }}
          >
            {logs.slice(-2).map((line, i) => (
              <p key={i} className="text-[10px] font-mono text-zinc-600 leading-4 truncate">
                {stripAnsi(line)}
              </p>
            ))}
          </div>
        )}

        {/* Volume chips — shown when stopped and has volumes */}
        {!isActive && (service.volumes ?? []).length > 0 && (
          <div className="mx-3.5 mb-3 flex flex-wrap gap-1">
            {(service.volumes ?? []).map((v, i) => (
              <span key={i} className="text-[9px] font-mono text-zinc-700 bg-white/[0.03] border border-white/[0.05] px-1.5 py-0.5 rounded truncate max-w-[180px]">
                {v}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Log viewer */}
      {logsOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-[2px] flex items-center justify-center z-50">
          <div className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl w-[640px] max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.06]">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
              <p className="text-[13px] font-medium text-zinc-100 flex-1">{service.name}</p>
              <span className="text-[11px] text-zinc-600 font-mono">{service.image}:{service.tag}</span>
              <button
                onClick={() => clearServiceLogs(service.id)}
                className="text-[11px] text-zinc-600 hover:text-zinc-300 transition-colors ml-2"
              >Clear</button>
              <button
                onClick={() => setLogsOpen(false)}
                className="ml-2 p-1 text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 terminal-log-font">
              {logs.length === 0 ? (
                <p className="text-[12px] text-zinc-600">No logs yet</p>
              ) : (
                logs.map((line, i) => (
                  <p key={i} className={`terminal-log-line text-[11px] ${
                    line.startsWith("[err]") ? "text-red-400/80" : "text-zinc-400"
                  }`}>
                    {stripAnsi(line)}
                  </p>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <Suspense fallback={null}>
        {settingsOpen && (
          <ServiceSettingsModal service={service} onClose={() => setSettingsOpen(false)} />
        )}
      </Suspense>
    </>
  );
}

export default memo(ServiceCard);
