import { useState, useRef } from "react";
import { runSetup } from "../lib/commands";
import { usePortaStore } from "../store";

type StepState = "idle" | "loading" | "done" | "error";

function StepIcon({ state }: { state: StepState }) {
  if (state === "loading") {
    return <span className="spinner text-blue-400" />;
  }
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

export default function SetupWizard() {
  const { setupStatus, checkSetup } = usePortaStore();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Prevent wizard from disappearing mid-setup due to polling flicker
  const setupStarted = useRef(false);

  if (!setupStatus) return null;

  const allGood =
    setupStatus.caddy_installed &&
    setupStatus.dnsmasq_installed &&
    setupStatus.test_resolver_exists &&
    setupStatus.caddy_running;

  // Only hide when fully done AND we're not in the middle of a run
  if (allGood && !running && !setupStarted.current) return null;

  function stepState(ok: boolean): StepState {
    if (ok) return "done";
    if (running) return "loading";
    if (error) return "error";
    return "idle";
  }

  const steps = [
    { key: "caddy_installed",       label: "Install Caddy",            ok: setupStatus.caddy_installed,       note: "Reverse proxy" },
    { key: "dnsmasq_installed",     label: "Install dnsmasq",          ok: setupStatus.dnsmasq_installed,     note: "DNS resolver" },
    { key: "test_resolver_exists",  label: "Configure .test resolver", ok: setupStatus.test_resolver_exists,  note: "/etc/resolver/test" },
    { key: "caddy_running",         label: "Start Caddy service",      ok: setupStatus.caddy_running,         note: "brew services" },
  ];

  async function handleRunSetup() {
    setupStarted.current = true;
    setRunning(true);
    setError(null);

    // Poll every 1.2s so the UI reflects each step as it finishes
    const poll = setInterval(async () => {
      try { await checkSetup(); } catch {}
    }, 1200);

    try {
      await runSetup();
      await checkSetup();
    } catch (e) {
      setError(String(e));
    } finally {
      clearInterval(poll);
      setRunning(false);
      // Small delay before allowing wizard to close — avoids flicker
      if (!error) setTimeout(() => { setupStarted.current = false; }, 800);
    }
  }

  return (
    <div className="fixed inset-0 bg-[#111113]/95 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-[#1c1c1e] border border-white/[0.08] rounded-2xl p-7 w-[380px] shadow-2xl">
        {/* Icon */}
        <div className="w-11 h-11 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-5">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-blue-400">
            <path d="M10 2L3 6v4c0 3.5 3 6.7 7 8 4-1.3 7-4.5 7-8V6l-7-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          </svg>
        </div>

        <h1 className="text-[17px] font-semibold text-zinc-100 mb-1">Welcome to Porta</h1>
        <p className="text-[13px] text-zinc-500 mb-6 leading-relaxed">
          One-time setup needed. Porta will install Caddy and dnsmasq via Homebrew to manage your local domains.
        </p>

        {/* Steps */}
        <ul className="flex flex-col gap-2.5 mb-6">
          {steps.map((step) => {
            const state = stepState(step.ok);
            return (
              <li key={step.key} className="flex items-center gap-3">
                <StepIcon state={state} />
                <div className="flex-1 min-w-0">
                  <span className={`text-[13px] ${
                    state === "done"    ? "text-zinc-300" :
                    state === "loading" ? "text-zinc-200" :
                    state === "error"   ? "text-red-400"  :
                    "text-zinc-500"
                  }`}>
                    {step.label}
                  </span>
                </div>
                <span className="text-[11px] text-zinc-700 shrink-0">{step.note}</span>
              </li>
            );
          })}
        </ul>

        {/* Error detail */}
        {error && (
          <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
            <p className="text-[12px] text-red-400 leading-relaxed">{error}</p>
          </div>
        )}

        <button
          onClick={handleRunSetup}
          disabled={running}
          className="w-full py-2 rounded-lg text-[13px] font-medium transition-all duration-150 disabled:opacity-50 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white"
        >
          {running && <span className="spinner text-white/70" />}
          {running ? "Installing…" : error ? "Retry Setup" : "Run Setup"}
        </button>

        {running && (
          <p className="text-[11px] text-zinc-600 text-center mt-3">
            This may take a few minutes. Admin password may be required.
          </p>
        )}
      </div>
    </div>
  );
}
