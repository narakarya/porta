import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri, runSetup } from "../../lib/commands";
import { usePortaStore } from "../../store";
import { detectLevel, LEVEL_CLS, stripAnsi } from "../../lib/log-utils";

type StepState = "idle" | "loading" | "done" | "error";

const STEP_ORDER = [
  "caddy_installed",
  "dnsmasq_installed",
  "test_resolver_exists",
  "mkcert_installed",
  "certs_generated",
  "caddy_running",
];

const STEP_ESTIMATE: Record<string, string> = {
  caddy_installed:      "~2-5 min",
  dnsmasq_installed:    "~1-3 min",
  test_resolver_exists: "instant",
  mkcert_installed:     "~1-2 min",
  certs_generated:      "instant",
  caddy_running:        "~5 sec",
};

function StepIcon({ state }: { state: StepState }) {
  if (state === "loading") return <span className="spinner text-blue-400 shrink-0" />;
  if (state === "done") {
    return (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" className="text-emerald-400 shrink-0">
        <path d="M2.5 6.5l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (state === "error") {
    return (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" className="text-red-400 shrink-0">
        <path d="M3 3l7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    );
  }
  return <span className="w-[13px] h-[13px] rounded-full border border-zinc-700 shrink-0" />;
}

function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      onClick={copy}
      className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 transition-colors ${className}`}
      title="Copy to clipboard"
    >
      {copied ? (
        <>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6.5l2.5 2.5L9.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.1" />
            <path d="M2 8V2.5Q2 2 2.5 2H8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

interface Props {
  forceShow?: boolean;
  onClose?: () => void;
}

export default function SetupWizard({ forceShow, onClose }: Props = {}) {
  const { setupStatus, checkSetup } = usePortaStore();
  const [running, setRunning] = useState(false);
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [setupStarted, setSetupStarted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Tauri's event listener is unavailable in the browser preview. Keeping the
    // guard here makes the local design/dev build behave like the desktop app
    // without generating unhandled promise rejections.
    if (!isTauri) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    listen<string>("setup:step", (e) => {
      setActiveStep(e.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    listen<string>("setup:log", (e) => {
      setLogs((prev) => [...prev, e.payload]);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (!setupStatus) return null;

  // caddy_running is intentionally excluded — it's runtime state, not setup state.
  // Porta handles a stopped Caddy separately (auto-start banner) so the wizard
  // doesn't pop up on every launch after a reboot.
  const allGood =
    setupStatus.caddy_installed &&
    setupStatus.dnsmasq_installed &&
    setupStatus.test_resolver_exists &&
    setupStatus.mkcert_installed &&
    setupStatus.certs_generated;

  if ((dismissed || (allGood && !setupStarted)) && !forceShow) return null;

  const okByKey: Record<string, boolean> = {
    caddy_installed:      setupStatus.caddy_installed,
    dnsmasq_installed:    setupStatus.dnsmasq_installed,
    test_resolver_exists: setupStatus.test_resolver_exists,
    mkcert_installed:     setupStatus.mkcert_installed,
    certs_generated:      setupStatus.certs_generated,
    caddy_running:        setupStatus.caddy_running,
  };
  // First step still pending — used to show *one* spinner in the brief window
  // before the backend emits its first `setup:step` event.
  const firstPendingIdx = STEP_ORDER.findIndex((k) => !okByKey[k]);

  function stepState(ok: boolean, key: string): StepState {
    if (ok) return "done";
    const activeIdx = STEP_ORDER.indexOf(activeStep ?? "");
    const keyIdx = STEP_ORDER.indexOf(key);
    // A run failed: mark only the step that was running when it broke; every
    // step that never got reached stays idle (not a misleading red X).
    if (error) return keyIdx === activeIdx ? "error" : "idle";
    if (!running) return "idle";
    // No step event yet — warm up the first pending row only.
    if (activeIdx < 0) return keyIdx === firstPendingIdx ? "loading" : "idle";
    // Exactly the active step spins; everything else waits.
    return keyIdx === activeIdx ? "loading" : "idle";
  }

  const steps = [
    { key: "caddy_installed",      label: "Install Caddy",               ok: okByKey.caddy_installed },
    { key: "dnsmasq_installed",    label: "Install dnsmasq",             ok: okByKey.dnsmasq_installed },
    { key: "test_resolver_exists", label: "Configure .test resolver",    ok: okByKey.test_resolver_exists },
    { key: "mkcert_installed",     label: "Install mkcert",              ok: okByKey.mkcert_installed },
    { key: "certs_generated",      label: "Generate SSL certificates",   ok: okByKey.certs_generated },
    { key: "caddy_running",        label: "Start Caddy (HTTPS)",         ok: okByKey.caddy_running },
  ];

  async function handleRunSetup() {
    setSetupStarted(true);
    setRunning(true);
    setActiveStep(null);
    setLogs([]);
    setError(null);

    const poll = setInterval(async () => {
      try { await checkSetup(); } catch {}
    }, 1200);

    try {
      await runSetup();
      await checkSetup();
      if (forceShow && onClose) setTimeout(onClose, 1000);
    } catch (e) {
      setError(String(e));
      // Keep activeStep so stepState() can flag the row that actually failed.
    } finally {
      clearInterval(poll);
      setRunning(false);
    }
  }

  const activeStepLabel = steps.find((s) => s.key === activeStep)?.label;

  return (
    <div className="fixed inset-0 bg-[#111113]/95 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl p-7 w-[440px] shadow-2xl relative flex flex-col gap-5">

        {/* Header */}
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" className="text-blue-400">
              <path d="M10 2L3 6v4c0 3.5 3 6.7 7 8 4-1.3 7-4.5 7-8V6l-7-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="flex-1">
            <h1 className="text-[15px] font-semibold text-zinc-100">
              {forceShow ? "Setup & Certificates" : "Welcome to Porta"}
            </h1>
            <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
              {forceShow
                ? "Re-run setup to regenerate SSL certs or fix broken services."
                : "One-time setup. Installs Caddy, dnsmasq, and mkcert via Homebrew."
              }
            </p>
          </div>
          {forceShow && onClose && !running && (
            <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition-colors mt-0.5">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>

        {/* Steps */}
        <ul className="flex flex-col gap-2">
          {steps.map((step) => {
            const state = stepState(step.ok, step.key);
            const isActive = state === "loading";
            return (
              <li key={step.key} className={`flex items-center gap-3 px-2 py-1 rounded-lg transition-colors ${isActive ? "bg-blue-500/[0.06]" : ""}`}>
                <StepIcon state={state} />
                <span className={`flex-1 text-[13px] transition-colors ${
                  state === "done"    ? "text-zinc-400" :
                  state === "loading" ? "text-zinc-100 font-medium" :
                  state === "error"   ? "text-red-400"  :
                  "text-zinc-600"
                }`}>
                  {step.label}
                </span>
                {state === "loading" ? (
                  <span className="text-[11px] text-blue-400 shrink-0">
                    {STEP_ESTIMATE[step.key]}
                  </span>
                ) : state === "idle" && !running ? (
                  <span className="text-[11px] text-zinc-700 shrink-0">
                    {STEP_ESTIMATE[step.key]}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>

        {/* Live log */}
        {(running || logs.length > 0) && (
          <div className="flex flex-col gap-1.5">
            {activeStepLabel && running && (
              <p className="text-[11px] text-blue-400 font-medium">{activeStepLabel}…</p>
            )}
            <div className="relative bg-black/40 rounded-lg border border-white/[0.06] h-[120px] overflow-auto px-3 py-2 terminal-log-font select-text">
              {logs.length > 0 && (
                <CopyButton
                  text={logs.map(stripAnsi).join("\n")}
                  className="sticky top-0 float-right z-10 bg-white/[0.04] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08]"
                />
              )}
              {logs.map((line, i) => {
                const clean = stripAnsi(line);
                const level = detectLevel(clean);
                const cls = level ? LEVEL_CLS[level] : "text-zinc-400";
                return (
                  <p key={i} className={`terminal-log-line text-[11px] ${cls}`}>{clean}</p>
                );
              })}
              {running && logs.length === 0 && (
                <p className="text-[11px] text-zinc-600">Starting…</p>
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] text-red-400 leading-relaxed font-mono select-text whitespace-pre-wrap break-words">{error}</p>
              <CopyButton
                text={error}
                className="shrink-0 text-red-300/80 hover:text-red-200 hover:bg-red-500/15"
              />
            </div>
          </div>
        )}

        {allGood && !running && !error && setupStarted ? (
          <button
            onClick={() => forceShow ? onClose?.() : setDismissed(true)}
            className="w-full py-2 rounded-lg text-[13px] font-medium transition-all flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            Done
          </button>
        ) : (
          <button
            onClick={handleRunSetup}
            disabled={running}
            className="w-full py-2 rounded-lg text-[13px] font-medium transition-all disabled:opacity-60 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white"
          >
            {running && <span className="spinner text-white/70" />}
            {running ? "Running…" : error ? "Retry" : forceShow ? "Re-run Setup" : "Run Setup"}
          </button>
        )}
      </div>
    </div>
  );
}
