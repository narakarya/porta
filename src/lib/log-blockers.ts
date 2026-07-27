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
    // "Error: listen EADDRINUSE 127.0.0.1:4000"
    test: /EADDRINUSE[^0-9]*(\d{2,5})?/i,
    build: (m) => ({
      kind: "port",
      port: m[1] ? Number(m[1]) : null,
      label: m[1] ? `Port :${m[1]} is already in use` : "That port is already in use",
    }),
  },
  {
    // Erlang/Elixir: "Failed to start Ranch listener … :eaddrinuse"
    test: /:eaddrinuse\b/i,
    build: () => ({ kind: "port", port: null, label: "That port is already in use" }),
  },
  {
    // Vite: "Port 3000 is in use", Rails: "Address already in use - bind(2) for
    // 127.0.0.1:3000", Go: "bind: address already in use"
    test: /(?:port\s+(\d{2,5})\s+is (?:already )?in use|address already in use(?:[^0-9]*(\d{2,5}))?)/i,
    build: (m) => {
      const p = m[1] ?? m[2];
      return {
        kind: "port",
        port: p ? Number(p) : null,
        label: p ? `Port :${p} is already in use` : "That port is already in use",
      };
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
  for (let i = lines.length - 1; i >= start; i--) {
    const line = stripAnsi(lines[i] ?? "");
    if (!line) continue;
    for (const rule of RULES) {
      const m = line.match(rule.test);
      if (!m) continue;
      const blocker = rule.build(m);
      // A bare `EADDRINUSE` with a junk capture (a PID-looking number that is
      // really part of an IPv6 address) still tells us the port is taken; the
      // caller falls back to the app's own port.
      if (blocker) return blocker;
    }
  }
  return null;
}
