import { useEffect, useState } from "react";
import {
  getAppHealthProbe,
  setAppHealthProbe,
  clearAppHealthProbe,
  runAppHealthProbe,
  type HealthProbe,
  type ProbeKind,
  type ProbeResult,
} from "../../lib/commands";
import Field from "../shared/Field";

interface Props {
  appId: string;
  appPort: number;
  defaultPath: string | null;
}

const DEFAULT_PROBE = (appPort: number, defaultPath: string | null): HealthProbe => ({
  kind: defaultPath ? "http" : "tcp",
  target: defaultPath
    ? `http://localhost:${appPort}${defaultPath}`
    : `127.0.0.1:${appPort}`,
  interval_sec: 10,
  timeout_sec: 2,
  expected_http_status: null,
  expected_exit_code: null,
  enabled: true,
});

function formatTimestamp(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
}

export default function HealthSection({ appId, appPort, defaultPath }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [hasCustom, setHasCustom] = useState(false);
  const [probe, setProbe] = useState<HealthProbe>(DEFAULT_PROBE(appPort, defaultPath));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [lastResult, setLastResult] = useState<ProbeResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = await getAppHealthProbe(appId).catch(() => null);
      if (cancelled) return;
      if (existing) {
        setProbe(existing);
        setHasCustom(true);
      } else {
        setProbe(DEFAULT_PROBE(appPort, defaultPath));
        setHasCustom(false);
      }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [appId, appPort, defaultPath]);

  function update<K extends keyof HealthProbe>(key: K, value: HealthProbe[K]) {
    setProbe((p) => ({ ...p, [key]: value }));
    setSavedAt(null);
  }

  function changeKind(kind: ProbeKind) {
    setProbe((p) => {
      const target =
        kind === "http"
          ? p.kind === "http" ? p.target : `http://localhost:${appPort}${defaultPath ?? "/"}`
          : kind === "tcp"
            ? p.kind === "tcp" ? p.target : `127.0.0.1:${appPort}`
            : p.kind === "cmd" ? p.target : `nc -z 127.0.0.1 ${appPort}`;
      return { ...p, kind, target };
    });
    setSavedAt(null);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await setAppHealthProbe(appId, probe);
      setHasCustom(true);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    try {
      await clearAppHealthProbe(appId);
      setProbe(DEFAULT_PROBE(appPort, defaultPath));
      setHasCustom(false);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    // Run the probe as currently configured. If the user has unsaved edits,
    // those won't be reflected because run_app_health_probe reads from disk.
    // Persist first if dirty, but skip clobbering "hasCustom = false" state.
    setTesting(true);
    try {
      // Inline test: persist current draft so the run uses the user's edits.
      // For default (no custom probe), the backend synthesizes from app fields.
      if (savedAt === null && hasCustom) {
        await setAppHealthProbe(appId, probe);
      }
      const res = await runAppHealthProbe(appId);
      setLastResult(res);
    } catch (e) {
      setLastResult({
        ok: false,
        latency_ms: 0,
        message: String(e),
        checked_at: Math.floor(Date.now() / 1000),
      });
    } finally {
      setTesting(false);
    }
  }

  if (!loaded) {
    return (
      <div className="text-[12px] text-zinc-500">Loading probe…</div>
    );
  }

  return (
    <>
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Health</h1>
        <p className="text-[12px] text-zinc-500 mt-1">
          Customize how Porta checks this app's health. Without a custom probe,
          Porta uses the built-in HTTP/TCP check based on the app's port and
          health check path.
        </p>
      </div>

      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <label className="flex items-center gap-2 text-[12px] text-zinc-300">
          <input
            type="checkbox"
            checked={probe.enabled}
            onChange={(e) => update("enabled", e.target.checked)}
            className="accent-blue-500"
          />
          Probe enabled
        </label>

        <Field label="Probe type">
          <div className="flex gap-1.5">
            {(["http", "tcp", "cmd"] as ProbeKind[]).map((k) => {
              const active = probe.kind === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => changeKind(k)}
                  className={`px-3 py-1.5 text-[12px] rounded-lg border transition-colors ${
                    active
                      ? "bg-blue-500/15 border-blue-500/40 text-blue-200"
                      : "bg-white/[0.03] border-white/[0.08] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
                  }`}
                >
                  {k === "http" ? "HTTP" : k === "tcp" ? "TCP" : "Command"}
                </button>
              );
            })}
          </div>
        </Field>

        <Field
          label={
            probe.kind === "http"
              ? "Target URL"
              : probe.kind === "tcp"
                ? "host:port"
                : "Shell command"
          }
        >
          <input
            spellCheck={false}
            value={probe.target}
            onChange={(e) => update("target", e.target.value)}
            placeholder={
              probe.kind === "http"
                ? "http://localhost:3000/health"
                : probe.kind === "tcp"
                  ? "127.0.0.1:5432"
                  : "curl -fsS http://localhost:3000/health"
            }
            className="input-base font-mono text-[12px]"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label={`Interval (sec) — ${probe.interval_sec}`}>
            <input
              type="range"
              min={1}
              max={300}
              step={1}
              value={probe.interval_sec}
              onChange={(e) => update("interval_sec", parseInt(e.target.value, 10) || 10)}
              className="w-full accent-blue-500"
            />
          </Field>

          <Field label="Timeout (sec)">
            <input
              type="number"
              min={1}
              max={120}
              value={probe.timeout_sec}
              onChange={(e) => update("timeout_sec", parseInt(e.target.value, 10) || 2)}
              className="input-base"
            />
          </Field>
        </div>

        {probe.kind === "http" && (
          <Field label="Expected HTTP status (blank = 200–399)">
            <input
              type="number"
              min={100}
              max={599}
              value={probe.expected_http_status ?? ""}
              onChange={(e) => {
                const v = e.target.value.trim();
                update("expected_http_status", v === "" ? null : parseInt(v, 10));
              }}
              placeholder="200"
              className="input-base"
            />
          </Field>
        )}

        {probe.kind === "cmd" && (
          <Field label="Expected exit code (blank = 0)">
            <input
              type="number"
              value={probe.expected_exit_code ?? ""}
              onChange={(e) => {
                const v = e.target.value.trim();
                update("expected_exit_code", v === "" ? null : parseInt(v, 10));
              }}
              placeholder="0"
              className="input-base"
            />
          </Field>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="px-3 py-1.5 text-[12px] font-medium bg-white/[0.05] hover:bg-white/[0.08] text-zinc-200 rounded-lg border border-white/[0.08] disabled:opacity-50 transition-colors"
          >
            {testing ? "Testing…" : "Test now"}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : hasCustom ? "Save probe" : "Enable custom probe"}
          </button>
          {hasCustom && (
            <button
              type="button"
              onClick={handleReset}
              disabled={saving}
              className="px-3 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 rounded-lg transition-colors"
            >
              Reset to default
            </button>
          )}
          {savedAt !== null && (
            <span className="text-[11px] text-emerald-400/80 ml-1">Saved</span>
          )}
        </div>

        {lastResult && (
          <div
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] border ${
              lastResult.ok
                ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-200"
                : "bg-red-500/10 border-red-500/25 text-red-200"
            }`}
          >
            <span className="font-mono text-[11px]">
              {lastResult.ok ? "OK" : "FAIL"}
            </span>
            <span>·</span>
            <span>{lastResult.latency_ms}ms</span>
            <span>·</span>
            <span className="truncate flex-1" title={lastResult.message}>
              {lastResult.message}
            </span>
            <span className="text-[10px] opacity-70 shrink-0">
              {formatTimestamp(lastResult.checked_at)}
            </span>
          </div>
        )}

        {!hasCustom && (
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            No custom probe saved yet — the form is pre-filled with the
            defaults Porta would synthesize from this app's port
            {defaultPath ? <> and health check path <code className="font-mono text-zinc-400">{defaultPath}</code></> : null}.
          </p>
        )}
      </div>
    </>
  );
}
