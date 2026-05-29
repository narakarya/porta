import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  /** Optional label that prefixes the error title — useful for nested boundaries. */
  scope?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Top-level error boundary. Catches render-time errors below it so a bad
 * commit doesn't leave the user staring at a blank window with nothing to
 * do but kill the app. Shows the error message + component stack, with a
 * Reload button that hard-reloads the WebView (Tauri reuses the same
 * process; this clears React state and the store, but the Rust side keeps
 * running with its open files/IPC subscriptions intact).
 *
 * Error boundaries can't catch errors in event handlers, async work, or
 * during server-side rendering — those would surface as unhandled promise
 * rejections that we don't intercept here. For those we rely on toasts or
 * inline error banners at the call site.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    // Surface in devtools console at least until we wire a real reporter.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught", error, info);
  }

  reset = () => {
    this.setState({ error: null, info: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    const err = this.state.error;
    const stack = this.state.info?.componentStack ?? "";
    const scope = this.props.scope ? `${this.props.scope}: ` : "";

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0a0a0c] text-zinc-200 p-6">
        <div className="max-w-2xl w-full bg-[#1a1a1c] border border-red-500/20 rounded-2xl p-6 shadow-2xl">
          <div className="flex items-start gap-3">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-red-400 mt-1 shrink-0">
              <path d="M10 2.5l8 14H2L10 2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
              <path d="M10 8v3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              <circle cx="10" cy="14" r="0.7" fill="currentColor"/>
            </svg>
            <div className="flex-1 min-w-0">
              <h1 className="text-[14px] font-semibold text-zinc-100">
                {scope}Something broke
              </h1>
              <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">
                The UI hit an error it couldn't recover from. Your background apps and Caddy are still running — this is a frontend-only crash.
              </p>

              <div className="mt-4 rounded-lg bg-black/30 border border-white/[0.05] p-3 max-h-72 overflow-auto">
                <p className="text-[11px] font-mono text-red-400 break-all">{err.name}: {err.message}</p>
                {stack && (
                  <pre className="mt-2 text-[10px] font-mono text-zinc-500 whitespace-pre-wrap break-all">{stack.trim()}</pre>
                )}
              </div>

              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={this.reset}
                  className="px-3 py-1.5 text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 rounded-md transition-colors"
                >
                  Try again
                </button>
                <button
                  onClick={() => window.location.reload()}
                  className="px-3 py-1.5 text-[11px] font-medium text-zinc-200 bg-white/[0.06] hover:bg-white/[0.10] rounded-md transition-colors"
                >
                  Reload window
                </button>
                <a
                  href={`https://github.com/narakarya/porta/issues/new?title=${encodeURIComponent("[crash] " + err.message)}&body=${encodeURIComponent("```\n" + (stack || err.stack || "") + "\n```")}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Report on GitHub →
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
