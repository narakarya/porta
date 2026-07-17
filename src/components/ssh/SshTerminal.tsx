import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { sshWrite, sshResize, isTauri } from "../../lib/commands";
import "@xterm/xterm/css/xterm.css";

interface Props {
  sessionId: string;
  visible: boolean;
}

export default function SshTerminal({ sessionId, visible }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Forward keyboard input to the remote shell.
    term.onData((data) => {
      sshWrite(sessionId, Array.from(new TextEncoder().encode(data))).catch(console.error);
    });

    // Keep the PTY size in sync with the terminal's own dimension changes.
    term.onResize(({ rows, cols }) => {
      sshResize(sessionId, rows, cols).catch(() => {});
    });
    sshResize(sessionId, term.rows, term.cols).catch(() => {});

    // Receive session output (byte array → Uint8Array → write) + exit notice.
    let mounted = true;
    let unlistenData: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    if (isTauri) {
      Promise.all([
        listen<number[]>(`ssh:data:${sessionId}`, (e) => {
          if (!mounted) return;
          term.write(new Uint8Array(e.payload));
        }),
        listen<void>(`ssh:exit:${sessionId}`, () => {
          if (mounted) term.write("\r\n\x1b[90m[session closed]\x1b[0m\r\n");
        }),
      ]).then(([d, x]) => {
        if (!mounted) {
          d();
          x();
          return;
        }
        unlistenData = d;
        unlistenExit = x;
      });
    } else {
      term.writeln("\x1b[90m(Terminal unavailable outside Tauri app)\x1b[0m");
    }

    const onResize = () => fitAddon.fit();
    window.addEventListener("resize", onResize);

    return () => {
      mounted = false;
      window.removeEventListener("resize", onResize);
      unlistenData?.();
      unlistenExit?.();
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-[#0d0d0f]"
      style={{ display: visible ? "block" : "none" }}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}
