import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { terminalOpen, terminalWrite, terminalResize, isTauri } from "../../lib/commands";
import { highlightLine, stripAnsi } from "../../lib/log-utils";
import "@xterm/xterm/css/xterm.css";

const MAX_TRANSCRIPT_LINES = 100_000;

interface Props {
  appId: string;
  rootDir: string;
  visible: boolean;
  startupCommand?: string | null;
  searchQuery?: string;
  filterOutput?: boolean;
  onOutput?: () => void;
  onTranscriptStats?: (lineCount: number, matchCount: number | null) => void;
  /** Shell exited — carries the code so the status bar can show `exited (1)`. */
  onExit?: (code: number) => void;
  /** The pane took keyboard focus — drives the split-view focus ring. */
  onFocus?: () => void;
}

function bytesToTranscriptText(bytes: number[], decoder: TextDecoder): string {
  return stripAnsi(decoder.decode(new Uint8Array(bytes), { stream: true }))
    .replace(/\x07/g, "");
}

function appendTerminalTextToTranscript(text: string, initialLine: string): { line: string; lines: string[] } {
  let line = initialLine;
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\r") {
      if (text[i + 1] === "\n") {
        lines.push(line);
        line = "";
        i += 1;
        continue;
      }
      line = "";
      continue;
    }
    if (char === "\n") {
      lines.push(line);
      line = "";
      continue;
    }
    if (char === "\b" || char === "\x7f") {
      line = line.slice(0, -1);
      continue;
    }
    if (char === "\t") {
      line += "  ";
      continue;
    }
    if (char >= " ") line += char;
  }
  return { line, lines };
}

export default function TerminalTab({
  appId,
  rootDir,
  visible,
  startupCommand,
  searchQuery = "",
  filterOutput = false,
  onOutput,
  onTranscriptStats,
  onExit,
  onFocus,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const transcriptRef = useRef<string[]>([]);
  const partialLineRef = useRef("");
  const transcriptCaptureStartedRef = useRef(false);
  const decoderRef = useRef(new TextDecoder());
  const flushTimerRef = useRef<number | null>(null);
  const [transcript, setTranscript] = useState<string[]>([]);
  const onOutputRef = useRef(onOutput);
  const onTranscriptStatsRef = useRef(onTranscriptStats);
  const onExitRef = useRef(onExit);
  const onFocusRef = useRef(onFocus);
  onOutputRef.current = onOutput;
  onTranscriptStatsRef.current = onTranscriptStats;
  onExitRef.current = onExit;
  onFocusRef.current = onFocus;

  const query = searchQuery.trim();
  const lowerQuery = query.toLowerCase();
  const filteredTranscript = useMemo(() => {
    if (!lowerQuery) return transcript;
    return transcript.filter((line) => line.toLowerCase().includes(lowerQuery));
  }, [transcript, lowerQuery]);

  const transcriptVisible = filterOutput || !!query;
  const matchCount = query ? filteredTranscript.length : null;

  useEffect(() => {
    if (!visible) return;
    onTranscriptStatsRef.current?.(transcript.length, matchCount);
  }, [visible, transcript.length, matchCount]);

  function scheduleTranscriptFlush() {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      setTranscript([...transcriptRef.current]);
    }, 80);
  }

  function startTranscriptCapture() {
    if (transcriptCaptureStartedRef.current) return;
    transcriptCaptureStartedRef.current = true;
    partialLineRef.current = "";
  }

  function appendTranscript(bytes: number[]) {
    if (!transcriptCaptureStartedRef.current) return;

    const text = bytesToTranscriptText(bytes, decoderRef.current);
    if (!text) return;

    const { line, lines: nextLines } = appendTerminalTextToTranscript(text, partialLineRef.current);
    partialLineRef.current = line;

    if (nextLines.length > 0) {
      transcriptRef.current.push(...nextLines);
      if (transcriptRef.current.length > MAX_TRANSCRIPT_LINES) {
        transcriptRef.current = transcriptRef.current.slice(-MAX_TRANSCRIPT_LINES);
      }
      scheduleTranscriptFlush();
    }
  }

  // Force xterm canvas repaint when the tab becomes visible after being hidden.
  // display:none → block doesn't auto-repaint the WebGL/canvas renderer.
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (!term || !fitAddon) return;
    requestAnimationFrame(() => {
      fitAddon.fit();
      term.refresh(0, term.rows - 1);
    });
  }, [visible]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#0d0d0f",
        foreground: "#d4d4d4",
        cursor: "#a0a0a0",
        black: "#1e1e20",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#d4d4d4",
        brightBlack: "#52525b",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde68a",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f4f4f5",
        selectionBackground: "#3f3f46",
      },
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: MAX_TRANSCRIPT_LINES,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fitAddon;

    // Forward keyboard input to the PTY shell.
    term.onData((data) => {
      startTranscriptCapture();
      const bytes = Array.from(new TextEncoder().encode(data));
      terminalWrite(appId, bytes).catch(console.error);
    });

    // Terminal itself has no public focus event — the `onFocus` getter that
    // exists at runtime belongs to xterm's internal core terminal, not the
    // public wrapper (`new Terminal().onFocus` is `undefined`), so calling it
    // is a permanent no-op. `textarea` *is* public: it's the actual hidden
    // input xterm focuses on click, Tab, or a programmatic `.focus()`, so a
    // native listener on it is the most direct signal that this pane's
    // terminal — specifically, not a sibling button like the pane's close
    // control — took keyboard focus. (A `focus`-capture handler on the pane's
    // wrapper `div` in TerminalWorkspace was the other option; it would also
    // fire for that sibling chrome, which this doesn't.)
    const focusListener = () => onFocusRef.current?.();
    term.textarea?.addEventListener("focus", focusListener);

    let mounted = true;
    let unlistenData: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    // Live chunks that land before the backlog has been replayed would render
    // ahead of it. Hold them, then flush in order.
    let backlogWritten = false;
    const queued: number[][] = [];
    // Set synchronously right after both `listen()` calls actually land (or,
    // in the non-Tauri branch, immediately — there's nothing to wait for).
    // Guards the ResizeObserver's own retry path below: per the HTML
    // rendering steps, animation-frame callbacks run *before* resize
    // observations are broadcast in the same frame, so `attach()` — queued
    // via `requestAnimationFrame` — starts and immediately suspends at
    // `await Promise.all([listen(...), listen(...)])` before the observer's
    // first delivery arrives, on every *visible* mount (a hidden pane is the
    // only case that needs the observer's retry at all). Without this guard
    // the observer would call `terminal_open` itself before either listener
    // exists, and anything the reader thread emits in that window reaches
    // neither the not-yet-taken backlog snapshot nor a listener — silently
    // dropped output.
    let listenersReady = false;

    function consume(bytes: number[]) {
      appendTranscript(bytes);
      term.write(new Uint8Array(bytes));
      onOutputRef.current?.();
    }

    // Guards `terminal_open` to run exactly once per mount. Set synchronously
    // (before the first await) so a ResizeObserver callback firing again
    // while the open is already in flight — or attach()'s own dims check
    // racing the observer's initial callback — can't issue a second one.
    let opened = false;

    async function openSession(dims: { rows: number; cols: number }) {
      if (opened || !mounted) return;
      opened = true;

      const { spawned, backlog } = await terminalOpen(
        appId,
        rootDir,
        dims.rows,
        dims.cols,
        startupCommand ?? null,
      );
      if (!mounted) return;

      if (backlog.length > 0) {
        // Reattaching to a session that outlived its last view: replay what it
        // printed while nothing was watching.
        startTranscriptCapture();
        consume(backlog);
      }
      backlogWritten = true;
      for (const chunk of queued) consume(chunk);
      queued.length = 0;

      // The startup command is written by Rust only on a real spawn, so a
      // reattach must not re-run it here either.
      if (spawned && startupCommand?.trim()) startTranscriptCapture();
    }

    async function attach() {
      if (!mounted) return;
      if (isTauri) {
        const [d, x] = await Promise.all([
          listen<number[]>(`terminal:data:${appId}`, (e) => {
            if (!mounted) return;
            if (!backlogWritten) { queued.push(e.payload); return; }
            consume(e.payload);
          }),
          listen<{ code: number }>(`terminal:exit:${appId}`, (e) => {
            if (!mounted) return;
            term.writeln("\r\n\x1b[90m— shell exited —\x1b[0m");
            onExitRef.current?.(e.payload?.code ?? 0);
          }),
        ]);
        if (!mounted) { d(); x(); return; }
        unlistenData = d;
        unlistenExit = x;
        listenersReady = true;
      } else {
        // Browser mock: no IPC bridge to listen on, but terminalOpen below
        // still resolves (commands.ts falls back to a mock) so tests and the
        // web preview keep working.
        term.writeln("\x1b[90m(Terminal unavailable outside Tauri app)\x1b[0m");
        listenersReady = true;
      }

      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      // `proposeDimensions()` is undefined when the container measures 0×0 —
      // exactly what a pane mounted into a `display:none` subtree looks like.
      // Don't fabricate a size here: a fabricated 80×24 was tried and
      // reverted because it spawns the real PTY at the wrong winsize and
      // hard-wraps its startup output. Leave `opened` false and bail — the
      // ResizeObserver below is what notices this container getting a real
      // size later and retries the open then. The listeners above are
      // already registered either way, so nothing the live session emits in
      // the meantime is lost — it queues until the open completes.
      if (!dims) return;
      await openSession(dims);
    }

    const attachRaf = requestAnimationFrame(() => { void attach().catch(console.error); });

    // Resize observer — keep PTY in sync with container size changes, and —
    // for a pane that mounted hidden — retry the deferred open the first
    // time this container actually measures a real size.
    // IMPORTANT: check pixel dimensions before calling fitAddon.fit() — calling it on a
    // 0×0 container (e.g. when hidden via display:none) corrupts xterm's internal viewport.
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const { width, height } = containerRef.current.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (!dims || dims.rows <= 0 || dims.cols <= 0) return;
      if (!opened) {
        // Don't race attach(): only open from here once its listeners are
        // actually registered (see `listenersReady` above). If they aren't
        // yet, attach() itself is still mid-flight and will perform the open
        // via its own dims check once it resumes — this retry exists solely
        // for the case attach() genuinely bailed for lack of any dimensions.
        if (!listenersReady) return;
        void openSession(dims).catch(console.error);
        return;
      }
      terminalResize(appId, dims.rows, dims.cols).catch(() => {});
    });
    ro.observe(containerRef.current!);

    return () => {
      mounted = false;
      cancelAnimationFrame(attachRaf);
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      ro.disconnect();
      term.textarea?.removeEventListener("focus", focusListener);
      unlistenData?.();
      unlistenExit?.();
      term.dispose();
      // Deliberately no terminalClose: the session outlives this view. Only a
      // user action (close tab, close pane, delete app) tears a PTY down.
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, rootDir]);

  // The gutter lives on the wrapper below, not on the element xterm opens into:
  // FitAddon measures `term.element.parentElement` (i.e. `containerRef`), so
  // padding there would size the grid to the full width and let the last column
  // sit underneath it.
  return (
    <div
      className="relative h-full w-full bg-[#0d0d0f] pl-3 pr-2 py-2"
      // A click landing in the gutter never reaches xterm, so focus it here —
      // otherwise the outer few pixels read as a dead zone.
      onMouseDown={(e) => { if (e.target === e.currentTarget) termRef.current?.focus(); }}
    >
      <div
        ref={containerRef}
        className="h-full w-full bg-[#0d0d0f]"
        style={{ visibility: transcriptVisible ? "hidden" : "visible" }}
        // Let xterm.js handle all keyboard events inside the terminal area.
        onKeyDown={(e) => e.stopPropagation()}
      />

      {transcriptVisible && (
        <div className="absolute inset-0 overflow-auto bg-[#0d0d0f] px-3 py-2 font-mono text-[12px] leading-[1.45] text-zinc-300">
          {filteredTranscript.length === 0 ? (
            <div className="h-full flex items-center justify-center text-[12px] text-zinc-600">
              {query ? "No terminal output matches the current filter." : "No terminal output yet."}
            </div>
          ) : (
            <div className="min-w-max pb-3">
              {filteredTranscript.map((line, idx) => (
                <div key={`${idx}-${line}`} className="flex gap-3 whitespace-pre">
                  <span className="w-10 shrink-0 text-right text-zinc-700 select-none tabular-nums">{idx + 1}</span>
                  <span>{query ? highlightLine(line, query) : line}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
