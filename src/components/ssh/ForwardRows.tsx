import { usePortaStore } from "../../store";
import type { SshForwardRuntime, SshPortForward } from "../../lib/commands";
import { Spinner } from "../ui";

type Props = { hostId: string; connected: boolean };

/** Live port forwards, listed under their host row.
 *
 *  Start/stop lives here rather than in the host form because it only means
 *  anything against a live session — and this is the one place where the
 *  session's state is visible at the same time. */
export default function ForwardRows({ hostId, connected }: Props) {
  const forwards = usePortaStore((s) => s.sshForwards[hostId]);
  const runtime = usePortaStore((s) => s.forwardRuntime);
  const startForward = usePortaStore((s) => s.startForward);
  const stopForward = usePortaStore((s) => s.stopForward);
  const notifyError = usePortaStore((s) => s.notifyError);

  // Nothing to say about a host with no rules — an empty register under every
  // host would be noise in a list that is mostly hosts without forwards.
  if (!forwards || forwards.length === 0) return null;

  return (
    <div className="ml-[30px] border-l border-subtle flex flex-col gap-px py-0.5">
      {forwards.map((f) => (
        <Row
          key={f.id}
          forward={f}
          runtime={runtime[f.id]}
          connected={connected}
          onStart={() => startForward(f).catch((e) => notifyError(`Couldn't open ${describe(f)}`, e))}
          onStop={() => stopForward(f).catch((e) => notifyError(`Couldn't stop ${describe(f)}`, e))}
        />
      ))}
    </div>
  );
}

function describe(f: SshPortForward) {
  return f.label || `${f.remote_host}:${f.remote_port}`;
}

function Row({
  forward,
  runtime,
  connected,
  onStart,
  onStop,
}: {
  forward: SshPortForward;
  runtime?: SshForwardRuntime;
  connected: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const state = runtime?.state ?? "stopped";
  const live = state === "listening";
  // The bound port only exists at runtime when the rule says "auto" (0), so
  // prefer what the backend reported and fall back to the rule.
  const port = runtime?.local_port || forward.local_port;

  return (
    <div className="group/fwd flex items-center gap-2 pl-3 pr-2 py-1 rounded-control hover:bg-white/[0.04] transition-colors">
      <span className="shrink-0 w-3 flex items-center justify-center">
        {state === "starting" ? (
          <Spinner size={10} />
        ) : (
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              live ? "bg-ok" : state === "failed" ? "bg-bad" : "bg-ink-3"
            }`}
          />
        )}
      </span>

      <span className="flex-1 min-w-0 flex flex-col leading-tight">
        <span className="truncate text-[12px] text-ink-2">{describe(forward)}</span>
        <span className="truncate text-[10.5px] text-ink-3 font-mono mt-px">
          {live && port ? `:${port}` : forward.local_port ? `:${forward.local_port}` : "auto"}
          {/* A listening forward with no traffic is healthy, not dead — say
              "idle" rather than leaving the line to read as a failure. */}
          {live && (
            <span className="font-sans">
              {" · "}
              {runtime && runtime.active_conns > 0 ? `${runtime.active_conns} active` : "idle"}
            </span>
          )}
        </span>
      </span>

      {connected && (
        <button
          onClick={live || state === "starting" ? onStop : onStart}
          disabled={state === "starting"}
          title={live ? "Stop forward" : "Start forward"}
          aria-label={live ? "Stop forward" : "Start forward"}
          className="shrink-0 opacity-0 group-hover/fwd:opacity-100 w-5 h-5 flex items-center justify-center rounded-control text-ink-3 hover:text-ink hover:bg-white/[0.06] disabled:opacity-30 transition-colors"
        >
          {live ? (
            <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
              <rect x="1.5" y="1.5" width="7" height="7" rx="1" />
            </svg>
          ) : (
            <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
              <path d="M2.5 1.5l6 3.5-6 3.5z" />
            </svg>
          )}
        </button>
      )}

      {/* The raw backend string, verbatim — "port in use by node (pid 4711)"
          is the whole value here, and summarising it away is a regression. */}
      {runtime?.error && (
        <span className="shrink-0 max-w-[9rem] truncate text-[10px] text-bad" title={runtime.error}>
          {runtime.error}
        </span>
      )}
    </div>
  );
}
