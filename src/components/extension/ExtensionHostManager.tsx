import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import ExtensionPanel, { type ExtensionInvoker } from "../app/ExtensionPanel";
import type { App } from "../../types";
import type { ExtensionInfo } from "../../types/extension";

// ── Lazy headless extension host ──────────────────────────────────────────────
// Extensions are iframes. To run an appAction (a command) without opening the
// full panel, we mount the iframe *hidden* on first invoke and keep it warm.
// The bridge (`portaBridge.commands.register`) runs the extension's handler and
// streams the result back. This is the "command-first" layer — clicking an
// action button or a palette entry routes through invokeAction() below.

type HostKey = string;
const keyOf = (appId: string, extId: string): HostKey => `${appId}::${extId}`;

interface HostEntry {
  app: App;
  extension: ExtensionInfo;
}

interface ReadyState {
  ready: boolean;
  waiters: Array<() => void>;
}

interface InvokeContext {
  /** Run an extension's appAction by id. Mounts the host on demand. */
  invokeAction: (app: App, extension: ExtensionInfo, actionId: string) => Promise<void>;
}

const Ctx = createContext<InvokeContext | null>(null);

export function useExtensionInvoke(): InvokeContext {
  const c = useContext(Ctx);
  if (!c) throw new Error("useExtensionInvoke must be used within <ExtensionHostProvider>");
  return c;
}

interface Toast {
  id: number;
  msg: string;
  kind: "info" | "success" | "error";
}

export function ExtensionHostProvider({ children }: { children: React.ReactNode }) {
  const [hosts, setHosts] = useState<Map<HostKey, HostEntry>>(new Map());
  const invokersRef = useRef<Map<HostKey, ExtensionInvoker | null>>(new Map());
  const readyRef = useRef<Map<HostKey, ReadyState>>(new Map());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  function ensureReady(key: HostKey): ReadyState {
    let st = readyRef.current.get(key);
    if (!st) {
      st = { ready: false, waiters: [] };
      readyRef.current.set(key, st);
    }
    return st;
  }

  const waitReady = useCallback((key: HostKey) => {
    return new Promise<void>((resolve) => {
      const st = ensureReady(key);
      if (st.ready) resolve();
      else st.waiters.push(resolve);
    });
  }, []);

  const handleReady = useCallback((key: HostKey) => {
    const st = ensureReady(key);
    st.ready = true;
    const waiters = st.waiters.splice(0);
    waiters.forEach((fn) => fn());
  }, []);

  const pushToast = useCallback((msg: string, kind: Toast["kind"]) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const invokeAction = useCallback(
    async (app: App, extension: ExtensionInfo, actionId: string) => {
      const key = keyOf(app.id, extension.id);
      if (!hosts.has(key)) {
        setHosts((m) => {
          if (m.has(key)) return m;
          const n = new Map(m);
          n.set(key, { app, extension });
          return n;
        });
      }
      // Wait for the iframe bridge to boot, then run the command. The bridge
      // itself queues the call until the extension registers the handler.
      await waitReady(key);
      const invoker = invokersRef.current.get(key);
      if (!invoker) throw new Error("extension host failed to initialize");
      try {
        await invoker(actionId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Sentinel: the extension never registered this action as a command.
        // Let the caller fall back (open the full panel) instead of toasting.
        if (msg !== "__unregistered__") pushToast(msg, "error");
        throw e;
      }
    },
    [hosts, waitReady, pushToast],
  );

  const value = useMemo<InvokeContext>(() => ({ invokeAction }), [invokeAction]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Hidden hosts — mounted once invoked, kept warm. Persist across page
          switches since the provider sits above the page router. */}
      <div aria-hidden="true" style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}>
        {[...hosts.entries()].map(([key, h]) => (
          <ExtensionPanel
            key={key}
            headless
            app={h.app}
            extension={h.extension}
            onReady={() => handleReady(key)}
            registerInvoker={(fn) => invokersRef.current.set(key, fn)}
            onToast={pushToast}
          />
        ))}
      </div>
      {toasts.length > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-1.5" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`px-3 py-1.5 rounded-lg text-[12px] shadow-lg border ${
                t.kind === "error"
                  ? "bg-red-500/15 text-red-300 border-red-500/25"
                  : t.kind === "success"
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/25"
                    : "bg-zinc-800/90 text-zinc-200 border-white/10"
              }`}
            >
              {t.msg}
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}
