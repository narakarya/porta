import { useState } from "react";
import { runSetup } from "../lib/commands";
import { usePortaStore } from "../store";

export default function SetupWizard() {
  const { setupStatus, checkSetup } = usePortaStore();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!setupStatus) return null;

  const allGood =
    setupStatus.caddy_installed &&
    setupStatus.dnsmasq_installed &&
    setupStatus.test_resolver_exists &&
    setupStatus.caddy_running;

  if (allGood) return null;

  async function handleRunSetup() {
    setRunning(true);
    setError(null);
    try {
      await runSetup();
      await checkSetup();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  const items = [
    { label: "Caddy installed", ok: setupStatus.caddy_installed },
    { label: "dnsmasq installed", ok: setupStatus.dnsmasq_installed },
    { label: ".test resolver configured", ok: setupStatus.test_resolver_exists },
    { label: "Caddy running", ok: setupStatus.caddy_running },
  ];

  return (
    <div className="fixed inset-0 bg-gray-950 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-8 w-96">
        <h1 className="text-xl font-semibold mb-2">Welcome to Porta</h1>
        <p className="text-sm text-gray-400 mb-6">
          First-time setup required. Porta will install Caddy and dnsmasq via
          Homebrew.
        </p>

        <ul className="flex flex-col gap-2 mb-6">
          {items.map((item) => (
            <li key={item.label} className="flex items-center gap-2 text-sm">
              <span className={item.ok ? "text-green-400" : "text-gray-500"}>
                {item.ok ? "✓" : "○"}
              </span>
              <span className={item.ok ? "text-gray-300" : "text-gray-500"}>
                {item.label}
              </span>
            </li>
          ))}
        </ul>

        {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

        <button
          onClick={handleRunSetup}
          disabled={running}
          className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 rounded-md text-sm disabled:opacity-50"
        >
          {running ? "Setting up…" : "Run Setup"}
        </button>
      </div>
    </div>
  );
}
