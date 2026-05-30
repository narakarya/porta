import type { PortaBridgeApp, PortaEvent, ShellResult } from "../types/extension";

// ── Message protocol (parent ↔ iframe) ───────────────────────────────────────

export type BridgeCallMessage = {
  type: "porta:call";
  id: string;
  method: string;
  args: unknown[];
};

export type BridgeResultMessage = {
  type: "porta:result";
  id: string;
  result?: unknown;
  error?: string;
};

export type BridgeEventMessage = {
  type: "porta:event";
  event: PortaEvent;
  payload: unknown;
};

export type BridgeSetTitleMessage = {
  type: "porta:setTitle";
  title: string;
};

export type BridgeToastMessage = {
  type: "porta:toast";
  msg: string;
  kind: "info" | "success" | "error";
};

/** One line of streaming output from a spawned process. */
export type BridgeStreamMessage = {
  type: "porta:stream";
  callId: string;
  channel: "stdout" | "stderr";
  line: string;
};

/** Final event sent when a spawned process exits. */
export type BridgeSpawnDoneMessage = {
  type: "porta:spawn-done";
  callId: string;
  code: number;
  timedOut: boolean;
  error?: string;
};

export type ParentMessage =
  | BridgeResultMessage
  | BridgeEventMessage
  | BridgeStreamMessage
  | BridgeSpawnDoneMessage;

export type IframeMessage =
  | BridgeCallMessage
  | BridgeSetTitleMessage
  | BridgeToastMessage;

// ── Bridge script injected into extension iframe ──────────────────────────────

/**
 * Generate the JS snippet injected into the extension iframe before its own
 * code runs. Creates `window.__portaBridge` / `window.portaBridge`.
 */
export function createBridgeScript(app: PortaBridgeApp, extensionId: string): string {
  return `
(function() {
  const _app = ${JSON.stringify(app)};
  const _extId = ${JSON.stringify(extensionId)};
  const _pending = new Map();
  const _spawnHandlers = new Map(); // callId → { callbacks, acc }
  let _callId = 0;
  const _listeners = {};

  function _call(method, args) {
    return new Promise((resolve, reject) => {
      const id = String(++_callId);
      _pending.set(id, { resolve, reject });
      window.parent.postMessage({ type: 'porta:call', id, method, args }, '*');
      setTimeout(() => {
        if (_pending.has(id)) {
          _pending.delete(id);
          reject(new Error('portaBridge call timed out: ' + method));
        }
      }, 60000);
    });
  }

  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'porta:result') {
      const p = _pending.get(data.id);
      if (!p) return;
      _pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    }

    if (data.type === 'porta:event') {
      const handlers = _listeners[data.event] || [];
      handlers.forEach(fn => { try { fn(data.payload); } catch(e) {} });
    }

    if (data.type === 'porta:stream') {
      const h = _spawnHandlers.get(data.callId);
      if (!h) return;
      if (data.channel === 'stdout') {
        h.acc.stdout.push(data.line);
        if (h.callbacks.onStdout) { try { h.callbacks.onStdout(data.line); } catch(e) {} }
      } else if (data.channel === 'stderr') {
        h.acc.stderr.push(data.line);
        if (h.callbacks.onStderr) { try { h.callbacks.onStderr(data.line); } catch(e) {} }
      }
    }

    if (data.type === 'porta:spawn-done') {
      const h = _spawnHandlers.get(data.callId);
      const p = _pending.get(data.callId);
      _spawnHandlers.delete(data.callId);
      _pending.delete(data.callId);
      if (!p) return;
      if (data.error) {
        p.reject(new Error(data.error));
      } else {
        const acc = h ? h.acc : { stdout: [], stderr: [] };
        p.resolve({
          stdout: acc.stdout.join('\\n'),
          stderr: acc.stderr.join('\\n'),
          code: data.code,
          timed_out: data.timedOut,
        });
      }
    }
  });

  window.__portaBridge = {
    app: _app,
    shell: {
      run(cmd, opts) {
        return _call('shell.run', [cmd, opts || {}]);
      },
      spawn(cmd, opts, callbacks) {
        callbacks = callbacks || {};
        const id = String(++_callId);
        const acc = { stdout: [], stderr: [] };
        _spawnHandlers.set(id, { callbacks, acc });
        const timeoutMs = (opts && opts.timeout) ? opts.timeout + 10000 : 310000;
        return new Promise((resolve, reject) => {
          _pending.set(id, { resolve, reject });
          window.parent.postMessage({ type: 'porta:call', id, method: 'shell.spawn', args: [cmd, opts || {}] }, '*');
          setTimeout(() => {
            if (_pending.has(id)) {
              _pending.delete(id);
              _spawnHandlers.delete(id);
              reject(new Error('portaBridge spawn timed out: ' + cmd));
            }
          }, timeoutMs);
        });
      },
    },
    ui: {
      toast(msg, kind = 'info') {
        window.parent.postMessage({ type: 'porta:toast', msg, kind }, '*');
      },
      setTitle(title) {
        window.parent.postMessage({ type: 'porta:setTitle', title }, '*');
      },
    },
    events: {
      on(event, handler) {
        if (!_listeners[event]) _listeners[event] = [];
        _listeners[event].push(handler);
        return () => {
          _listeners[event] = (_listeners[event] || []).filter(h => h !== handler);
        };
      },
    },
    storage: {
      get(key) { return _call('storage.get', [key]); },
      set(key, value) { return _call('storage.set', [key, value]); },
      remove(key) { return _call('storage.remove', [key]); },
      keys() { return _call('storage.keys', []); },
    },
  };

  window.portaBridge = window.__portaBridge;
})();
`;
}

// ── Message handler (React side) ─────────────────────────────────────────────

export type ShellRunHandler = (
  cmd: string,
  opts: { cwd?: string; timeout?: number }
) => Promise<ShellResult>;

export type ShellSpawnHandler = (
  cmd: string,
  opts: { cwd?: string; timeout?: number },
  callbacks: {
    onStream: (channel: "stdout" | "stderr", line: string) => void;
    onDone: (code: number, timedOut: boolean, error?: string) => void;
  },
) => Promise<void>;

/**
 * Creates a message event handler attached to `window` by ExtensionPanel.
 * Routes iframe `porta:call` messages to Tauri IPC and posts results back.
 */
export function createMessageHandler(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  onShellRun: ShellRunHandler,
  onShellSpawn: ShellSpawnHandler,
  onToast: (msg: string, kind: "info" | "success" | "error") => void,
  onSetTitle: (title: string) => void,
  onStorage: (method: "get" | "set" | "remove" | "keys", args: unknown[]) => Promise<unknown>,
) {
  return async function handleMessage(e: MessageEvent) {
    // Sandboxed iframes have null origin — also accept same-origin calls.
    if (e.origin !== "null" && e.origin !== window.location.origin) return;
    if (e.source !== iframeRef.current?.contentWindow) return;

    const data = e.data as IframeMessage;
    if (!data || typeof data !== "object") return;

    if (data.type === "porta:toast") {
      onToast(data.msg, data.kind);
      return;
    }

    if (data.type === "porta:setTitle") {
      onSetTitle(data.title);
      return;
    }

    if (data.type === "porta:call") {
      const { id, method, args } = data;

      // shell.spawn — streaming; no porta:result, uses porta:stream + porta:spawn-done
      if (method === "shell.spawn") {
        const [cmd, opts] = args as [string, { cwd?: string; timeout?: number }];
        onShellSpawn(cmd, opts ?? {}, {
          onStream: (channel, line) => {
            iframeRef.current?.contentWindow?.postMessage(
              { type: "porta:stream", callId: id, channel, line } satisfies BridgeStreamMessage,
              "*",
            );
          },
          onDone: (code, timedOut, error) => {
            iframeRef.current?.contentWindow?.postMessage(
              { type: "porta:spawn-done", callId: id, code, timedOut, error } satisfies BridgeSpawnDoneMessage,
              "*",
            );
          },
        }).catch((err) => {
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: "porta:spawn-done",
              callId: id,
              code: -1,
              timedOut: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies BridgeSpawnDoneMessage,
            "*",
          );
        });
        return;
      }

      // All other methods use the porta:result round-trip
      try {
        let result: unknown;
        if (method === "shell.run") {
          const [cmd, opts] = args as [string, { cwd?: string; timeout?: number }];
          result = await onShellRun(cmd, opts ?? {});
        } else if (method.startsWith("storage.")) {
          const sub = method.slice("storage.".length) as "get" | "set" | "remove" | "keys";
          result = await onStorage(sub, args);
        } else {
          throw new Error(`Unknown portaBridge method: ${method}`);
        }
        iframeRef.current?.contentWindow?.postMessage(
          { type: "porta:result", id, result } satisfies BridgeResultMessage,
          "*",
        );
      } catch (err) {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "porta:result", id, error: err instanceof Error ? err.message : String(err) } satisfies BridgeResultMessage,
          "*",
        );
      }
    }
  };
}

/**
 * Forward a Porta app event into the extension iframe.
 */
export function emitEventToIframe(
  iframe: HTMLIFrameElement | null,
  event: PortaEvent,
  payload: unknown,
) {
  iframe?.contentWindow?.postMessage(
    { type: "porta:event", event, payload } satisfies BridgeEventMessage,
    "*",
  );
}
