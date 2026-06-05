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

export type BridgeTerminalDataMessage = {
  type: "porta:terminal-data";
  termId: string;
  bytes: number[];
};

export type BridgeTerminalExitMessage = {
  type: "porta:terminal-exit";
  termId: string;
};

/** Parent → iframe: run a registered command (appAction) headlessly. */
export type BridgeInvokeMessage = {
  type: "porta:invoke";
  invokeId: string;
  actionId: string;
};

/** Iframe → parent: a command's bridge is live and listening. */
export type BridgeReadyMessage = {
  type: "porta:ready";
};

/** Iframe → parent: result of a porta:invoke round-trip. */
export type BridgeInvokeResultMessage = {
  type: "porta:invoke-result";
  invokeId: string;
  error?: string;
};

export type ParentMessage =
  | BridgeResultMessage
  | BridgeEventMessage
  | BridgeStreamMessage
  | BridgeSpawnDoneMessage
  | BridgeTerminalDataMessage
  | BridgeTerminalExitMessage
  | BridgeInvokeMessage;

export type IframeMessage =
  | BridgeCallMessage
  | BridgeSetTitleMessage
  | BridgeToastMessage
  | BridgeReadyMessage
  | BridgeInvokeResultMessage;

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
  const _termData = new Map(); // termId → Set<fn>
  const _termExit = new Map(); // termId → Set<fn>
  const _commands = new Map(); // actionId → handler fn
  const _pendingInvokes = []; // invokes that arrived before their command registered

  // Run a registered command and report its outcome back to the host.
  // Returns false if no handler is registered for actionId yet.
  function _dispatchInvoke(invokeId, actionId) {
    const fn = _commands.get(actionId);
    if (!fn) return false;
    Promise.resolve().then(() => fn()).then(
      () => window.parent.postMessage({ type: 'porta:invoke-result', invokeId }, '*'),
      (err) => window.parent.postMessage(
        { type: 'porta:invoke-result', invokeId, error: (err && err.message) ? err.message : String(err) },
        '*',
      ),
    );
    return true;
  }

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

    if (data.type === 'porta:invoke') {
      // Queue if the extension hasn't registered this command yet — its JS
      // may run after the bridge. commands.register() drains the queue.
      if (!_dispatchInvoke(data.invokeId, data.actionId)) {
        _pendingInvokes.push({ invokeId: data.invokeId, actionId: data.actionId });
        // If still unregistered after a short grace, tell the host so it can
        // fall back (e.g. open the full panel). Extensions that register
        // commands do so synchronously at boot, well under this window.
        setTimeout(() => {
          const i = _pendingInvokes.findIndex(p => p.invokeId === data.invokeId);
          if (i !== -1) {
            _pendingInvokes.splice(i, 1);
            window.parent.postMessage(
              { type: 'porta:invoke-result', invokeId: data.invokeId, error: '__unregistered__' },
              '*',
            );
          }
        }, 1200);
      }
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

    if (data.type === 'porta:terminal-data') {
      const set = _termData.get(data.termId);
      if (set) set.forEach((fn) => fn(new Uint8Array(data.bytes)));
      return;
    }
    if (data.type === 'porta:terminal-exit') {
      const set = _termExit.get(data.termId);
      if (set) set.forEach((fn) => fn());
      return;
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
    commands: {
      register(id, handler) {
        _commands.set(id, handler);
        // Drain invokes that arrived before this command was registered.
        for (let i = _pendingInvokes.length - 1; i >= 0; i--) {
          if (_pendingInvokes[i].actionId === id) {
            const queued = _pendingInvokes.splice(i, 1)[0];
            _dispatchInvoke(queued.invokeId, id);
          }
        }
        return () => { if (_commands.get(id) === handler) _commands.delete(id); };
      },
      list() { return Array.from(_commands.keys()); },
    },
    storage: {
      get(key) { return _call('storage.get', [key]); },
      set(key, value) { return _call('storage.set', [key, value]); },
      remove(key) { return _call('storage.remove', [key]); },
      keys() { return _call('storage.keys', []); },
    },
    terminal: {
      open(termId, opts) { return _call('terminal.open', [termId, opts || {}]); },
      write(termId, bytes) { return _call('terminal.write', [termId, Array.from(bytes)]); },
      resize(termId, rows, cols) { return _call('terminal.resize', [termId, rows, cols]); },
      close(termId) { return _call('terminal.close', [termId]); },
      onData(termId, fn) {
        if (!_termData.has(termId)) _termData.set(termId, new Set());
        _termData.get(termId).add(fn);
        return () => { const s = _termData.get(termId); if (s) s.delete(fn); };
      },
      onExit(termId, fn) {
        if (!_termExit.has(termId)) _termExit.set(termId, new Set());
        _termExit.get(termId).add(fn);
        return () => { const s = _termExit.get(termId); if (s) s.delete(fn); };
      },
    },
  };

  window.portaBridge = window.__portaBridge;

  // Tell the host the bridge is live and listening. The host gates the first
  // porta:invoke on this so messages aren't dropped before the iframe boots.
  window.parent.postMessage({ type: 'porta:ready' }, '*');
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
  onTerminal: (method: "open" | "write" | "resize" | "close", args: unknown[]) => Promise<void>,
  onReady?: () => void,
  onInvokeResult?: (invokeId: string, error?: string) => void,
) {
  return async function handleMessage(e: MessageEvent) {
    // Sandboxed iframes have null origin — also accept same-origin calls.
    if (e.origin !== "null" && e.origin !== window.location.origin) return;
    if (e.source !== iframeRef.current?.contentWindow) return;

    const data = e.data as IframeMessage;
    if (!data || typeof data !== "object") return;

    if (data.type === "porta:ready") {
      onReady?.();
      return;
    }

    if (data.type === "porta:invoke-result") {
      onInvokeResult?.(data.invokeId, data.error);
      return;
    }

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
          const sub = method.slice("storage.".length);
          if (sub !== "get" && sub !== "set" && sub !== "remove" && sub !== "keys") {
            throw new Error(`Unknown storage method: ${sub}`);
          }
          if ((sub === "get" || sub === "set" || sub === "remove") && typeof args[0] !== "string") {
            throw new Error(`storage.${sub}: key must be a string`);
          }
          result = await onStorage(sub, args);
        } else if (method.startsWith("terminal.")) {
          const sub = method.slice("terminal.".length);
          if (sub !== "open" && sub !== "write" && sub !== "resize" && sub !== "close") {
            throw new Error(`Unknown terminal method: ${sub}`);
          }
          await onTerminal(sub, args);
          result = null;
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
 * Ask the extension iframe to run a registered command (appAction). The
 * result comes back as a `porta:invoke-result` message keyed by `invokeId`.
 */
export function invokeActionInIframe(
  iframe: HTMLIFrameElement | null,
  invokeId: string,
  actionId: string,
) {
  iframe?.contentWindow?.postMessage(
    { type: "porta:invoke", invokeId, actionId } satisfies BridgeInvokeMessage,
    "*",
  );
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
