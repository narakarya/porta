import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { extensionShellRun, readExtensionFile } from "../../lib/commands";
import {
  createBridgeScript,
  createMessageHandler,
  emitEventToIframe,
  type ShellSpawnHandler,
} from "../../lib/extensionBridge";
import type { ExtensionInfo } from "../../types/extension";
import type { App } from "../../types";

interface Props {
  app: App;
  extension: ExtensionInfo;
  reloadKey?: number;
  onTitleChange?: (title: string) => void;
  onToast?: (msg: string, kind: "info" | "success" | "error") => void;
}

type SpawnEventFromRust =
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "done"; code: number; timedOut: boolean };

function injectIntoHtml(html: string, bridgeScript: string, baseHref: string): string {
  const injection = `<base href="${baseHref}">\n<script>\n${bridgeScript}\n</script>`;
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch && headMatch.index !== undefined) {
    const pos = headMatch.index + headMatch[0].length;
    return html.slice(0, pos) + "\n" + injection + "\n" + html.slice(pos);
  }
  return `<head>\n${injection}\n</head>\n${html}`;
}

export default function ExtensionPanel({ app, extension, reloadKey = 0, onTitleChange, onToast }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const bridgeApp = {
    id: app.id,
    name: app.name,
    rootDir: app.root_dir,
    port: app.port,
    status: app.status,
    kind: app.kind,
  };

  useEffect(() => {
    let cancelled = false;
    setSrcDoc(null);
    setLoadError(null);
    readExtensionFile(extension.main_path)
      .then((html) => {
        if (cancelled) return;
        const mainUrl = convertFileSrc(extension.main_path);
        const baseHref = mainUrl.substring(0, mainUrl.lastIndexOf("/") + 1);
        const bridgeScript = createBridgeScript(bridgeApp, extension.id);
        setSrcDoc(injectIntoHtml(html, bridgeScript, baseHref));
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(String(e));
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extension.main_path, extension.id, reloadKey]);

  const handleShellRun = useCallback(
    (cmd: string, opts: { cwd?: string; timeout?: number }) =>
      extensionShellRun(app.id, extension.id, cmd, {
        cwdOverride: opts.cwd,
        timeoutMs: opts.timeout,
      }),
    [app.id, extension.id],
  );

  const handleShellSpawn = useCallback<ShellSpawnHandler>(
    async (cmd, opts, { onStream, onDone }) => {
      const { Channel, invoke: tauriInvoke } = await import("@tauri-apps/api/core");
      const channel = new Channel<SpawnEventFromRust>();
      channel.onmessage = (evt) => {
        if (evt.type === "stdout" || evt.type === "stderr") {
          onStream(evt.type, evt.line);
        } else if (evt.type === "done") {
          onDone(evt.code, evt.timedOut);
        }
      };
      await tauriInvoke("extension_shell_spawn", {
        appId: app.id,
        extensionId: extension.id,
        cmd,
        cwdOverride: opts.cwd ?? null,
        timeoutMs: opts.timeout ?? null,
        onEvent: channel,
      });
    },
    [app.id, extension.id],
  );

  const handleToast = useCallback(
    (msg: string, kind: "info" | "success" | "error") => onToast?.(msg, kind),
    [onToast],
  );

  const handleSetTitle = useCallback(
    (title: string) => onTitleChange?.(title),
    [onTitleChange],
  );

  useEffect(() => {
    const handler = createMessageHandler(
      iframeRef,
      handleShellRun,
      handleShellSpawn,
      handleToast,
      handleSetTitle,
    );
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [handleShellRun, handleShellSpawn, handleToast, handleSetTitle]);

  const prevStatusRef = useRef(app.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (app.status !== prev) {
      prevStatusRef.current = app.status;
      const evt =
        app.status === "running" ? "app:started" :
        app.status === "stopped" ? "app:stopped" : null;
      if (evt) emitEventToIframe(iframeRef.current, evt, { appId: app.id });
    }
  }, [app.status, app.id]);

  return (
    <div className="flex-1 min-h-0 relative flex flex-col">
      {!srcDoc && !loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d0f] z-10">
          <div className="flex items-center gap-2 text-[12px] text-zinc-500">
            <svg className="animate-spin" width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M6.5 1A5.5 5.5 0 1 1 1 6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
            Loading extension…
          </div>
        </div>
      )}
      {loadError && (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-sm flex flex-col gap-2">
            <p className="text-[12px] text-red-400 font-medium">Failed to load extension</p>
            <p className="text-[11px] text-zinc-500 font-mono break-all">{loadError}</p>
            <p className="text-[11px] text-zinc-600">Check that the extension's main file exists at:<br /><code className="text-zinc-500">{extension.main_path}</code></p>
          </div>
        </div>
      )}
      {srcDoc && (
        <iframe
          key={`${extension.id}-${reloadKey}`}
          ref={iframeRef}
          srcDoc={srcDoc}
          className="flex-1 w-full border-0 bg-[#0d0d0f]"
          title={extension.name}
        />
      )}
    </div>
  );
}
