import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  extensionShellRun,
  readExtensionFile,
  extensionStorageGet,
  extensionStorageSet,
  extensionStorageRemove,
  extensionStorageKeys,
  terminalOpen,
  terminalWrite,
  terminalResize,
  terminalClose,
} from "../../lib/commands";
import {
  createBridgeScript,
  createMessageHandler,
  emitEventToIframe,
  type ShellSpawnHandler,
  type BridgeTerminalDataMessage,
  type BridgeTerminalExitMessage,
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

/**
 * Inline external <link rel="stylesheet"> and <script src> tags directly
 * into the HTML by reading their contents via the extension-file IPC.
 *
 * Why this instead of relying on the iframe's `<base href>` + tauri://
 * asset URLs: Tauri 2's asset protocol is off by default in this app
 * (`tauri.conf.json` has no `assetProtocol.enable`), so any relative
 * fetch from a srcdoc iframe returns 404 silently. Extensions then load
 * the HTML scaffold without their JS/CSS — visible as "tabs without
 * style, panes blank below" once the user actually opens the panel.
 *
 * Inlining sidesteps that protocol entirely. Only files inside the
 * extensions directory are readable via `readExtensionFile`, so the
 * trust boundary is identical to the previous approach.
 */
async function inlineExternalAssets(html: string, mainPath: string): Promise<string> {
  // Directory of the main HTML — relative paths in <link>/<script> resolve
  // against this, mirroring what a real browser would do with <base>.
  const dir = mainPath.substring(0, mainPath.lastIndexOf("/") + 1);

  // Skip URLs that are http(s) / data: / absolute on disk — those are
  // either remote (and would need their own permission story we don't
  // grant) or already abs paths we shouldn't re-root under `dir`.
  const isInlineable = (href: string) =>
    !/^(https?:|data:|file:|\/\/)/i.test(href);

  let out = html;

  // <link rel="stylesheet" href="X"> → <style>...</style>
  const linkRe = /<link\b([^>]*?)\brel=["']stylesheet["']([^>]*)>/gi;
  const linkTags = [...html.matchAll(linkRe)];
  for (const m of linkTags) {
    const hrefMatch = m[0].match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch || !isInlineable(hrefMatch[1])) continue;
    try {
      const css = await readExtensionFile(dir + hrefMatch[1]);
      out = out.replace(m[0], `<style data-inlined-from="${hrefMatch[1]}">\n${css}\n</style>`);
    } catch {
      // Leave the original tag in place; user-facing failure will be no
      // styles applied, which is what they'd see anyway without this fix.
    }
  }

  // <script src="X"></script> → <script>...</script>
  const scriptRe = /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi;
  const scriptTags = [...html.matchAll(scriptRe)];
  for (const m of scriptTags) {
    const src = m[2];
    if (!isInlineable(src)) continue;
    try {
      const js = await readExtensionFile(dir + src);
      out = out.replace(m[0], `<script data-inlined-from="${src}">\n${js}\n</script>`);
    } catch {
      // Same: leave the tag; iframe will hit the asset-protocol wall and
      // the extension won't activate, but at least it won't be silent.
    }
  }

  return out;
}

export default function ExtensionPanel({ app, extension, reloadKey = 0, onTitleChange, onToast }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const termUnlistenRef = useRef<Map<string, Array<() => void>>>(new Map());
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
    (async () => {
      try {
        const rawHtml = await readExtensionFile(extension.main_path);
        if (cancelled) return;
        // Inline external <link> stylesheets and <script src> bundles
        // first, so the resulting srcDoc is self-contained and doesn't
        // depend on the (disabled) asset protocol for relative fetches.
        const inlined = await inlineExternalAssets(rawHtml, extension.main_path);
        if (cancelled) return;
        // `baseHref` is still useful for *any* surviving relative URL
        // (e.g. images referenced from the inlined CSS); they'll fail
        // unless the asset protocol is later turned on, but at least
        // they get a stable base to resolve against.
        const mainUrl = convertFileSrc(extension.main_path);
        const baseHref = mainUrl.substring(0, mainUrl.lastIndexOf("/") + 1);
        const bridgeScript = createBridgeScript(bridgeApp, extension.id);
        setSrcDoc(injectIntoHtml(inlined, bridgeScript, baseHref));
      } catch (e) {
        if (cancelled) return;
        setLoadError(String(e));
      }
    })();
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

  const handleStorage = useCallback(
    (method: "get" | "set" | "remove" | "keys", args: unknown[]): Promise<unknown> => {
      switch (method) {
        case "get":    return extensionStorageGet(extension.id, args[0] as string);
        case "set":    return extensionStorageSet(extension.id, args[0] as string, args[1]);
        case "remove": return extensionStorageRemove(extension.id, args[0] as string);
        case "keys":   return extensionStorageKeys(extension.id);
        default:       return Promise.resolve();
      }
    },
    [extension.id],
  );

  const handleTerminal = useCallback(
    async (method: "open" | "write" | "resize" | "close", args: unknown[]): Promise<void> => {
      if (!extension.permissions.includes("terminal")) {
        throw new Error(`Extension '${extension.id}' does not have 'terminal' permission`);
      }
      if (!extension.enabled) {
        throw new Error(`Extension '${extension.id}' is disabled`);
      }
      const rawId = args[0] as string;
      const termId = `ext:${extension.id}:${rawId}`;
      if (method === "open") {
        termUnlistenRef.current.get(termId)?.forEach((fn) => fn());
        const opts = (args[1] ?? {}) as { cwd?: string; rows?: number; cols?: number };
        const cwd = opts.cwd ?? app.root_dir;
        if (
          cwd.split("/").includes("..") ||
          (cwd !== app.root_dir && !cwd.startsWith(app.root_dir + "/"))
        ) {
          throw new Error(`cwd '${cwd}' is outside app root_dir '${app.root_dir}'`);
        }
        const dataUn = await listen<number[]>(`terminal:data:${termId}`, (e) => {
          iframeRef.current?.contentWindow?.postMessage(
            { type: "porta:terminal-data", termId: rawId, bytes: e.payload } satisfies BridgeTerminalDataMessage,
            "*",
          );
        });
        const exitUn = await listen<void>(`terminal:exit:${termId}`, () => {
          iframeRef.current?.contentWindow?.postMessage(
            { type: "porta:terminal-exit", termId: rawId } satisfies BridgeTerminalExitMessage,
            "*",
          );
        });
        termUnlistenRef.current.set(termId, [dataUn, exitUn]);
        await terminalOpen(termId, cwd, opts.rows ?? 24, opts.cols ?? 80);
      } else if (method === "write") {
        await terminalWrite(termId, args[1] as number[]);
      } else if (method === "resize") {
        await terminalResize(termId, args[1] as number, args[2] as number);
      } else if (method === "close") {
        await terminalClose(termId);
        termUnlistenRef.current.get(termId)?.forEach((fn) => fn());
        termUnlistenRef.current.delete(termId);
      }
    },
    [extension.id, extension.enabled, extension.permissions, app.root_dir],
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
      handleStorage,
      handleTerminal,
    );
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [handleShellRun, handleShellSpawn, handleToast, handleSetTitle, handleStorage, handleTerminal]);

  useEffect(() => {
    const map = termUnlistenRef.current;
    return () => {
      for (const [termId, fns] of map.entries()) {
        terminalClose(termId).catch(() => {});
        fns.forEach((fn) => fn());
      }
      map.clear();
    };
  }, []);

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
