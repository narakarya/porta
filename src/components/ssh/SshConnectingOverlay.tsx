import { useEffect, useState } from "react";
import { usePortaStore } from "../../store";
import { SSH_PHASES, type SshSession } from "../../store/slices/ssh";
import { OsIcon } from "./OsIcon";

/** Human labels per backend phase, in handshake order. `slow` is what we say
 *  once a step overstays — a stalled TCP connect and a stalled shell request
 *  have nothing useful in common to advise. */
const STEPS: {
  phase: (typeof SSH_PHASES)[number];
  label: string;
  done: string;
  slow: string;
}[] = [
  {
    phase: "connecting",
    label: "Reaching host",
    done: "Reached",
    slow: "Check the host is up and the port is open.",
  },
  {
    phase: "verifying",
    label: "Verifying host key",
    done: "Verified",
    slow: "The server is slow to present its host key.",
  },
  {
    phase: "authenticating",
    label: "Authenticating",
    done: "Authenticated",
    slow: "The server is taking its time on auth.",
  },
  {
    phase: "opening-shell",
    label: "Starting shell",
    done: "Shell ready",
    slow: "The shell request hasn't been answered yet.",
  },
];

/** A host that answers in under a second never needs an explanation; one that
 *  hangs does. Past this many ms we say what is actually being waited on. */
const SLOW_AFTER_MS = 8000;

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M2.5 6.3l2.4 2.4 4.6-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Full-pane connect progress for an SSH session, layered over the (still blank)
 * terminal until the shell is live.
 *
 * Replaces what used to be a black rectangle with an amber dot in the tab: the
 * backend walks four distinct gates, two of which can block on the user (trust
 * prompt, password), so "nothing is happening" and "we are waiting on you"
 * looked exactly the same. The chain shows which gate is current; the caption
 * under it names who is being waited on.
 */
export default function SshConnectingOverlay({ session }: { session: SshSession }) {
  const host = usePortaStore((s) => s.sshHosts.find((h) => h.id === session.hostId));
  const prompt = usePortaStore((s) => s.sshPrompt);
  const disconnect = usePortaStore((s) => s.disconnectSsh);

  const [elapsed, setElapsed] = useState(() => Date.now() - session.startedAt);
  useEffect(() => {
    setElapsed(Date.now() - session.startedAt);
    const t = setInterval(() => setElapsed(Date.now() - session.startedAt), 200);
    return () => clearInterval(t);
  }, [session.startedAt]);

  // A prompt parks the backend mid-gate; a spinner there would imply the app is
  // busy when it is the user who has to act.
  const waiting = prompt?.sessionId === session.id ? prompt : null;
  const current = Math.max(0, STEPS.findIndex((s) => s.phase === session.phase));
  const step = STEPS[current];
  const slow = !waiting && elapsed > SLOW_AFTER_MS;

  const caption =
    waiting?.type === "trust"
      ? "Waiting for you to trust this host"
      : waiting?.type === "secret"
        ? `Waiting for the ${waiting.kind}`
        : step.label;

  return (
    <div className="h-full w-full flex items-center justify-center bg-[#0d0d0f] select-none">
      <div className="w-[264px] flex flex-col items-center text-center">
        {/* Identity — OS badge with a breathing ring, then label + address. */}
        <div className="relative w-12 h-12 flex items-center justify-center">
          {/* Soft halo behind the badge. `bg-accent/10` renders transparent
              here — the design tokens are hex CSS vars, which Tailwind's
              opacity modifier can't compose — so use the rgba `*-bg` tokens. */}
          <span
            className={`absolute -inset-2 rounded-2xl blur-md ${waiting ? "bg-warn-bg" : "bg-accent-bg"}`}
            aria-hidden
          />
          <span
            className={`absolute inset-0 rounded-xl animate-ping ${waiting ? "bg-warn-bg" : "bg-accent-bg"}`}
            style={{ animationDuration: "2.4s" }}
            aria-hidden
          />
          <span className="absolute inset-0 rounded-xl bg-white/[0.05] border border-white/[0.08]" aria-hidden />
          <span className="relative">
            <OsIcon os={host?.detected_os ?? null} size={22} />
          </span>
        </div>
        <div className="mt-3 text-[13px] font-medium text-ink truncate max-w-full">{session.label}</div>
        {host && (
          <div className="mt-0.5 text-[11px] text-ink-3 font-mono truncate max-w-full">
            {host.username}@{host.hostname}
            <span className="opacity-60">:{host.port}</span>
          </div>
        )}

        {/* Chained stepper: node · connector · node. Colour carries the meaning
            so the chain needs no per-step text — green behind (cleared), accent
            on the gate in flight, amber when the gate is us waiting on the user.
            The in-flight connector runs a sweep so a long gate still reads as
            moving rather than stuck. */}
        <div className="mt-5 flex items-center w-full px-1" role="list" aria-label="Connection progress">
          {STEPS.map((s, i) => {
            const done = i < current;
            const active = i === current;
            return (
              <div key={s.phase} className="contents">
                {i > 0 && (
                  <span
                    aria-hidden
                    className={`relative flex-1 h-[2px] rounded-full overflow-hidden transition-colors duration-base ${
                      i < current ? "bg-ok" : i === current ? "bg-white/10" : "bg-white/[0.07]"
                    }`}
                  >
                    {i === current && !waiting && (
                      <span className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent animate-progress-sweep" />
                    )}
                    {i === current && waiting && <span className="absolute inset-0 bg-warn-bg" />}
                  </span>
                )}
                <span
                  role="listitem"
                  title={done ? s.done : s.label}
                  aria-current={active ? "step" : undefined}
                  className={`relative shrink-0 w-[18px] h-[18px] rounded-full flex items-center justify-center transition-all duration-base ${
                    done
                      ? "bg-ok text-[#0d0d0f]"
                      : active && waiting
                        ? "border-2 border-warn shadow-[0_0_0_4px_var(--warning-bg)]"
                        : active
                          ? "border-2 border-accent shadow-[0_0_0_4px_var(--accent-bg)]"
                          : "border border-white/15"
                  }`}
                >
                  {done ? (
                    <CheckIcon />
                  ) : active && waiting ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
                  ) : active ? (
                    // Bright arc sweeping over the ring — reads as motion at
                    // 18px where a full spinner glyph would just look noisy.
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      className="absolute -inset-[3px] w-auto h-auto animate-spin text-accent-ink"
                      aria-hidden
                    >
                      <path d="M17 10a7 7 0 0 0-7-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>

        {/* Caption for the current node — the only step label that has to be
            spelled out, which keeps the chain uncluttered. */}
        <div className="mt-3 flex items-baseline justify-center gap-1.5">
          <span className={`text-[12px] ${waiting ? "text-warn" : "text-ink"}`}>{caption}</span>
          <span className="text-[10px] tabular-nums text-ink-3">{(elapsed / 1000).toFixed(1)}s</span>
        </div>

        <p className={`mt-1.5 text-[11px] leading-snug ${slow ? "text-warn" : "text-transparent"}`} aria-hidden={!slow}>
          {/* Reserved line — the hint appearing must not shift the chain. */}
          {slow ? step.slow : " "}
        </p>

        <button
          onClick={() => disconnect(session.id)}
          className="mt-4 px-4 py-1.5 text-[11px] text-ink-3 hover:text-ink bg-white/[0.04] hover:bg-white/[0.07] rounded-control transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
