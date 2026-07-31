// "Your app can't start because something else is already holding the thing it
// needs" — the one class of boot failure Porta can fix with a single click,
// because it knows how to kill both a PID and whatever owns a port.
//
// This used to be one regex living inside LogToast (`/held by process (\d+)/`),
// matching a phrasing almost nothing actually prints. The result was a kill
// button nobody ever saw. The rules below are anchored on what the tools really
// emit — `EADDRINUSE`, Erlang's `:eaddrinuse`, Vite's "Port 3000 is in use",
// esbuild/webpack lockfiles, and the handful of "held by pid N" variants.

import { stripAnsi } from "./log-utils";

export type Blocker =
  | { kind: "pid"; pid: number; label: string }
  /** `port` is null when the message says the port is taken but not which one —
   *  the caller fills in the app's configured port, which is the one it tried. */
  | { kind: "port"; port: number | null; label: string };

type Rule = {
  test: RegExp;
  build: (m: RegExpMatchArray) => Blocker | null;
};

/** A port number named elsewhere on the line — Ranch puts it in the listen
 *  args (`[port: 4000]`), before the error atom the rule anchors on. */
function portHint(line: string | undefined): number | null {
  const m = line?.match(/\bport:?\s*(\d{2,5})\b/i);
  return m ? Number(m[1]) : null;
}

function portBlocker(port: number | null): Blocker {
  return {
    kind: "port",
    port,
    label: port !== null ? `Port :${port} is already in use` : "That port is already in use",
  };
}

const RULES: Rule[] = [
  // ── A named process is sitting on a lock ──────────────────────────────────
  {
    // "lock is held by process 41234", "held by pid 41234",
    // "Another instance is running (pid 41234)"
    test: /(?:held by (?:process|pid)|another instance is running \(pid|locked by (?:process|pid))\s*#?(\d+)/i,
    build: (m) => ({ kind: "pid", pid: Number(m[1]), label: `Lock held by pid ${m[1]}` }),
  },
  {
    // Common lockfile phrasing: "waiting for lock … owned by 41234"
    test: /waiting for (?:the )?lock.*?(?:owned by|pid)\s*#?(\d+)/i,
    build: (m) => ({ kind: "pid", pid: Number(m[1]), label: `Lock held by pid ${m[1]}` }),
  },

  // ── The port is taken ─────────────────────────────────────────────────────
  {
    // Node/Vite/Bun: "listen EADDRINUSE: address already in use :::4000",
    // "Error: listen EADDRINUSE 127.0.0.1:4000". Case-insensitive, so this
    // also anchors Erlang's ":eaddrinuse" — where the port sits *before* the
    // atom, in Ranch's listen args — hence the portHint fallback.
    test: /EADDRINUSE[^0-9]*(\d{2,5})?/i,
    build: (m) => portBlocker(m[1] ? Number(m[1]) : portHint(m.input)),
  },
  {
    // Vite: "Port 3000 is in use", Bandit: "at http failed, port 4001 already
    // in use", Rails: "Address already in use - bind(2) for 127.0.0.1:3000",
    // Go: "bind: address already in use"
    test: /(?:port:?\s+(\d{2,5})\s+(?:is\s+)?(?:already\s+)?in use|address already in use(?:[^0-9]*(\d{2,5}))?)/i,
    build: (m) => {
      const p = m[1] ?? m[2];
      return portBlocker(p ? Number(p) : null);
    },
  },
];

/**
 * The most recent blocker in `lines`, or null.
 *
 * Scans newest-first over the tail: a run that hit EADDRINUSE, got fixed and
 * then failed on something else should not still be offering to free the port.
 */
export function detectBlocker(lines: string[], tail = 40): Blocker | null {
  const start = Math.max(0, lines.length - tail);
  // A port-taken report that doesn't name the port is usually the exit
  // summary — Elixir prints "** (EXIT) :eaddrinuse" several lines *after* the
  // endpoint line that says "port 4001 already in use". Returning the vague
  // hit immediately would blame the app's configured port, which for a
  // multi-endpoint app is exactly the port that ISN'T blocked. So a vague hit
  // is held as a fallback while the scan keeps looking for one with a number.
  let vague: Blocker | null = null;
  for (let i = lines.length - 1; i >= start; i--) {
    const line = stripAnsi(lines[i] ?? "");
    if (!line) continue;
    for (const rule of RULES) {
      const m = line.match(rule.test);
      if (!m) continue;
      const blocker = rule.build(m);
      if (!blocker) continue;
      // Newest-first still decides between unrelated failures: a pid lock
      // found below a vague port hit belongs to an older failure, so the
      // newer (vague) one wins.
      if (blocker.kind === "pid") return vague ?? blocker;
      if (blocker.port === null) {
        vague ??= blocker;
        break;
      }
      return blocker;
    }
  }
  return vague;
}
