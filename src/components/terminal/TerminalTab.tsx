import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { terminalOpen, terminalWrite, terminalResize, terminalClose, isTauri } from "../../lib/commands";
import "@xterm/xterm/css/xterm.css";

interface Props {
  appId: string;
  rootDir: string;
  visible: boolean;
  startupCommand?: string | null;
  onOutput?: () => void;
}

export default function TerminalTab({ appId, rootDir, visible, startupCommand, onOutput }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;

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
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Delay fit so the container is fully laid out.
    requestAnimationFrame(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims) terminalOpen(appId, rootDir, dims.rows, dims.cols, startupCommand ?? null).catch(console.error);
    });

    termRef.current = term;
    fitRef.current = fitAddon;

    // Forward keyboard input to the PTY shell.
    term.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));
      terminalWrite(appId, bytes).catch(console.error);
    });

    // Receive PTY output (byte array → Uint8Array → write).
    let mounted = true;
    let unlistenData: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    if (isTauri) {
      Promise.all([
        listen<number[]>(`terminal:data:${appId}`, (e) => {
          if (!mounted) return;
          term.write(new Uint8Array(e.payload));
          onOutputRef.current?.();
        }),
        listen<void>(`terminal:exit:${appId}`, () => {
          if (mounted) term.writeln("\r\n\x1b[90m— shell exited —\x1b[0m");
        }),
      ]).then(([d, x]) => {
        if (!mounted) { d(); x(); return; }
        unlistenData = d;
        unlistenExit = x;
      });
    } else {
      // Browser mock: show placeholder
      term.writeln("\x1b[90m(Terminal unavailable outside Tauri app)\x1b[0m");
    }

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
      ro.disconnect();
      unlistenData?.();
      unlistenExit?.();
      term.dispose();
      terminalClose(appId).catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, rootDir]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-[#0d0d0f]"
      // Let xterm.js handle all keyboard events inside the terminal area.
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}
