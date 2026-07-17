import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  listCloudflareZoneCerts,
  importCloudflareZoneCert,
  deleteCloudflareZoneCert,
  type ZoneCert,
} from "../../lib/commands";

/** Per-zone origin certs management. Lives in its own tab because it's a
 * niche concern — only relevant when routing tunnels across multiple
 * Cloudflare zones — so it shouldn't crowd the main Tunnels view. */
export default function CloudflareCertificatesSection() {
  const [zoneCerts, setZoneCerts] = useState<ZoneCert[]>([]);
  const [zoneInput, setZoneInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listCloudflareZoneCerts();
      setZoneCerts(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleImport(source: "default" | "pick") {
    const zone = zoneInput.trim().toLowerCase();
    if (!zone) {
      setError("Zone is required (e.g. example.com)");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      let sourcePath: string | null = null;
      if (source === "default") {
        const home = await import("@tauri-apps/api/path").then((m) => m.homeDir());
        sourcePath = `${home}/.cloudflared/cert.pem`;
      } else {
        const picked = await openDialog({
          multiple: false,
          directory: false,
          filters: [{ name: "Certificate", extensions: ["pem"] }],
        });
        if (typeof picked === "string") sourcePath = picked;
      }
      if (!sourcePath) return;
      await importCloudflareZoneCert(zone, sourcePath);
      setZoneInput("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  async function handleDelete(zone: string) {
    setError(null);
    const snapshot = zoneCerts;
    // Optimistic removal — revert if the backend rejects.
    setZoneCerts((prev) => prev.filter((z) => z.zone !== zone));
    try {
      await deleteCloudflareZoneCert(zone);
    } catch (e) {
      setZoneCerts(snapshot);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[14px] font-semibold text-ink">Per-zone Origin Certs</h2>
        <p className="text-[11.5px] text-ink-3 mt-0.5 leading-snug max-w-2xl">
          Cloudflare's <code className="font-mono">cert.pem</code> only authorizes the zones picked at <code className="font-mono">cloudflared login</code>. Apps in other zones need their own cert. Login per zone, then import the freshly-issued <code className="font-mono">~/.cloudflared/cert.pem</code> here — Porta picks the right one automatically when routing DNS.
        </p>
      </div>

      {error && (
        <div className="px-2.5 py-1.5 rounded-control bg-bad-bg border border-[rgba(248,113,113,0.3)] text-[11px] text-bad font-mono whitespace-pre-wrap">
          {error}
        </div>
      )}

      {zoneCerts.length > 0 && (
        <div className="flex flex-col divide-y divide-white/[0.04] rounded-card bg-surface-1 border border-subtle">
          {zoneCerts.map((c) => (
            <div key={c.zone} className="flex items-center justify-between px-3 py-2">
              <div className="flex flex-col min-w-0">
                <code className="font-mono text-[12px] text-ink">{c.zone}</code>
                <code className="font-mono text-[10px] text-ink-3 truncate">{c.path}</code>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(c.zone)}
                className="text-[11px] text-ink-3 hover:text-bad transition-colors shrink-0 ml-2"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={zoneInput}
          onChange={(e) => setZoneInput(e.target.value)}
          placeholder="example.com"
          spellCheck={false}
          className="flex-1 bg-surface-input border border-subtle rounded-control px-3 py-1.5 text-[12px] font-mono text-ink outline-none focus:border-[rgba(96,165,250,0.5)] transition-colors"
        />
        <button
          type="button"
          onClick={() => handleImport("default")}
          disabled={!zoneInput.trim() || importing}
          title="Import ~/.cloudflared/cert.pem"
          className="px-3 py-1.5 text-[12px] font-medium bg-accent hover:opacity-90 text-white rounded-control disabled:opacity-40 transition-colors shrink-0"
        >
          {importing ? "Importing…" : "Import current"}
        </button>
        <button
          type="button"
          onClick={() => handleImport("pick")}
          disabled={!zoneInput.trim() || importing}
          className="px-2.5 py-1.5 text-[12px] text-ink-2 hover:text-ink rounded-control disabled:opacity-40 transition-colors shrink-0"
        >
          Pick file…
        </button>
      </div>
    </div>
  );
}
