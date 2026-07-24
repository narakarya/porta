import { useState } from "react";
import { createCloudflareTunnel } from "../../lib/commands";

interface Props {
  step: number;
  /** Re-list tunnels once one exists, so the flow advances to the picker. */
  onCreated: () => void;
  loading?: boolean;
}

/**
 * Last step of the named-tunnel flow: create the tunnel from here instead of
 * sending the user to a terminal for `cloudflared tunnel create <name>`. The
 * name is the only thing Porta can't decide for them, so it's the only input.
 */
export default function CreateTunnelCard({ step, onCreated, loading = false }: Props) {
  const [name, setName] = useState("porta");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createCloudflareTunnel(trimmed);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-3 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)] flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <span className="shrink-0 w-5 h-5 rounded-full bg-[rgba(96,165,250,0.22)] text-accent-ink text-[11px] font-semibold flex items-center justify-center">
          {step}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium text-ink">Create your first tunnel</p>
          <p className="text-[11px] text-ink-3 mt-0.5">Give it any name — it shows up in the dropdown after.</p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void create(); } }}
          placeholder="porta"
          className="input-base text-[12px] py-1 flex-1 min-w-0"
        />
        <button
          type="button"
          onClick={() => { void create(); }}
          disabled={busy || !name.trim()}
          className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium rounded-md bg-accent text-white hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {busy && (
            <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
          {busy ? "Creating…" : "Create tunnel"}
        </button>
      </div>
      <button
        type="button"
        onClick={onCreated}
        disabled={loading || busy}
        className="self-start px-3 py-1 text-[11px] font-medium rounded-md bg-[rgba(96,165,250,0.12)] hover:bg-[rgba(96,165,250,0.22)] text-accent-ink transition-colors disabled:opacity-60"
      >
        {loading ? "Checking…" : "↻ I already have one"}
      </button>
      {error && <p className="text-[10px] text-bad leading-snug break-all">{error}</p>}
    </div>
  );
}
