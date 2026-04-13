import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri, terminalOpen, terminalWrite, terminalResize, terminalClose } from "../../lib/commands";

interface KamalConsolePaneProps {
  termId: string;
  workDir: string;
  initialCmd: string;
}

// Inline terminal pane for interactive kamal commands.
// Embeds an xterm.js terminal connected to a real PTY shell at workDir,
// then types the kamal command for the user.
export default function KamalConsolePane({ termId, workDir, initialCmd }: KamalConsolePaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let mounted = true;
    let unlistenData: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    import("@xterm/xterm").then(({ Terminal }) =>
      import("@xterm/addon-fit").then(({ FitAddon }) => {
        if (!mounted || !containerRef.current) return;

        const term = new Terminal({
          theme: {
            background: "#0d0d0f", foreground: "#d4d4d4", cursor: "#a0a0a0",
            black: "#1e1e20", red: "#f87171", green: "#4ade80", yellow: "#fbbf24",
            blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#d4d4d4",
            brightBlack: "#52525b", brightRed: "#fca5a5", brightGreen: "#86efac",
            brightYellow: "#fde68a", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe",
            brightCyan: "#67e8f9", brightWhite: "#f4f4f5", selectionBackground: "#3f3f46",
          },
          fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
          fontSize: 12, lineHeight: 1.4, cursorBlink: true, cursorStyle: "block",
          scrollback: 5000, allowProposedApi: true,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current!);

        requestAnimationFrame(async () => {
          fit.fit();
          const d = fit.proposeDimensions();
          if (!d) return;
          await terminalOpen(termId, workDir, d.rows, d.cols);
          // Type the kamal command into the shell after a short pause
          setTimeout(() => {
            const enc = new TextEncoder();
            terminalWrite(termId, Array.from(enc.encode(initialCmd + "\r"))).catch(() => {});
          }, 300);
        });

        term.onData((data) => {
          terminalWrite(termId, Array.from(new TextEncoder().encode(data))).catch(() => {});
        });

        if (isTauri) {
          Promise.all([
            listen<number[]>(`terminal:data:${termId}`, (e) => {
              if (mounted) term.write(new Uint8Array(e.payload));
            }),
            listen<void>(`terminal:exit:${termId}`, () => {
              if (mounted) term.writeln("\r\n\x1b[90m— shell exited —\x1b[0m");
            }),
          ]).then(([d, x]) => {
            if (!mounted) { d(); x(); return; }
            unlistenData = d; unlistenExit = x;
          });
        }

        const ro = new ResizeObserver(() => {
          if (!containerRef.current) return;
          const { width, height } = containerRef.current.getBoundingClientRect();
          if (width === 0 || height === 0) return;
          fit.fit();
          const dd = fit.proposeDimensions();
          if (dd && dd.rows > 0 && dd.cols > 0)
            terminalResize(termId, dd.rows, dd.cols).catch(() => {});
        });
        ro.observe(containerRef.current!);

        // Cleanup
        const origUnmount = () => {
          mounted = false;
          ro.disconnect();
          unlistenData?.(); unlistenExit?.();
          term.dispose();
          terminalClose(termId).catch(() => {});
        };
        // Store cleanup on the container for the outer cleanup to call
        (containerRef.current as HTMLDivElement & { _cleanup?: () => void })._cleanup = origUnmount;
      })
    );

    return () => {
      mounted = false;
      const el = containerRef.current as (HTMLDivElement & { _cleanup?: () => void }) | null;
      el?._cleanup?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 bg-[#0d0d0f]"
      onKeyDown={(e) => e.stopPropagation()} // prevent modal Esc from leaking
    />
  );
}
