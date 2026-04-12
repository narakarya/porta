import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { runSetup } from "../lib/commands";
import { usePortaStore } from "../store";

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

  const allGood =
    setupStatus.caddy_installed &&
    setupStatus.dnsmasq_installed &&
    setupStatus.test_resolver_exists &&
    setupStatus.caddy_running &&
    setupStatus.mkcert_installed &&
    setupStatus.certs_generated;

  if ((dismissed || (allGood && !setupStarted)) && !forceShow) return null;

  function stepState(ok: boolean, key: string): StepState {
    if (ok) return "done";
    if (error) return "error";
    if (!running) return "idle";
    const activeIdx = STEP_ORDER.indexOf(activeStep ?? "");
    const keyIdx = STEP_ORDER.indexOf(key);
    if (activeIdx < 0) return "loading";
    if (keyIdx === activeIdx) return "loading";
    if (keyIdx > activeIdx) return "idle";
    return "loading";
  }

  const steps = [
    { key: "caddy_installed",      label: "Install Caddy",               ok: setupStatus.caddy_installed },
    { key: "dnsmasq_installed",    label: "Install dnsmasq",             ok: setupStatus.dnsmasq_installed },
    { key: "test_resolver_exists", label: "Configure .test resolver",    ok: setupStatus.test_resolver_exists },
    { key: "mkcert_installed",     label: "Install mkcert",              ok: setupStatus.mkcert_installed },
    { key: "certs_generated",      label: "Generate SSL certificates",   ok: setupStatus.certs_generated },
    { key: "caddy_running",        label: "Start Caddy (HTTPS)",         ok: setupStatus.caddy_running },
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
    } finally {
      clearInterval(poll);
      setRunning(false);
      setActiveStep(null);
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
            <div className="bg-black/40 rounded-lg border border-white/[0.06] h-[120px] overflow-y-auto px-3 py-2 font-mono">
              {logs.map((line, i) => (
                <p key={i} className="text-[11px] text-zinc-400 leading-relaxed whitespace-pre-wrap break-all">{line}</p>
              ))}
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
            <p className="text-[12px] text-red-400 leading-relaxed font-mono">{error}</p>
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
