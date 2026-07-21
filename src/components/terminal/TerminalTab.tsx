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
  onOutputRef.current = onOutput;
  onTranscriptStatsRef.current = onTranscriptStats;
  onExitRef.current = onExit;

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

    let mounted = true;
    let unlistenData: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    // Live chunks that land before the backlog has been replayed would render
    // ahead of it. Hold them, then flush in order.
    let backlogWritten = false;
    const queued: number[][] = [];

    function consume(bytes: number[]) {
      appendTranscript(bytes);
      term.write(new Uint8Array(bytes));
      onOutputRef.current?.();
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
      } else {
        // Browser mock: no IPC bridge to listen on, but terminalOpen below
        // still resolves (commands.ts falls back to a mock) so tests and the
        // web preview keep working.
        term.writeln("\x1b[90m(Terminal unavailable outside Tauri app)\x1b[0m");
      }

      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (!dims) return;

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

    const attachRaf = requestAnimationFrame(() => { void attach().catch(console.error); });

    // Resize observer — keep PTY in sync with container size changes.
    // IMPORTANT: check pixel dimensions before calling fitAddon.fit() — calling it on a
    // 0×0 container (e.g. when hidden via display:none) corrupts xterm's internal viewport.
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const { width, height } = containerRef.current.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && dims.rows > 0 && dims.cols > 0)
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
      unlistenData?.();
      unlistenExit?.();
      term.dispose();
      // Deliberately no terminalClose: the session outlives this view. Only a
      // user action (close tab, close pane, delete app) tears a PTY down.
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, rootDir]);

  return (
    <div className="relative h-full w-full bg-[#0d0d0f]">
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
