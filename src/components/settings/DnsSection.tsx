import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cfDnsListZones,
  cfDnsListRecords,
  cfDnsCreateRecord,
  cfDnsUpdateRecord,
  cfDnsDeleteRecord,
  getCfApiToken,
  type DnsZone,
  type DnsRecord,
  type DnsRecordInput,
} from "../../lib/commands";
import { usePortaStore } from "../../store";

const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] as const;
type RecordType = typeof RECORD_TYPES[number];

const DEFAULT_TTL = 1; // CF uses 1 = "Auto"

interface FormState {
  recordType: RecordType;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: string; // string in form so empty == null
}

const blankForm: FormState = {
  recordType: "A",
  name: "",
  content: "",
  ttl: DEFAULT_TTL,
  proxied: false,
  priority: "",
};

function formToInput(form: FormState): DnsRecordInput {
  const priorityNum = form.priority.trim() === "" ? null : Number(form.priority);
  return {
    record_type: form.recordType,
    name: form.name.trim(),
    content: form.content.trim(),
    ttl: form.ttl,
    proxied: form.proxied,
    priority: priorityNum != null && !Number.isNaN(priorityNum) ? priorityNum : null,
  };
}

function recordToForm(rec: DnsRecord): FormState {
  return {
    recordType: (RECORD_TYPES as readonly string[]).includes(rec.record_type)
      ? (rec.record_type as RecordType)
      : "A",
    name: rec.name,
    content: rec.content,
    ttl: rec.ttl,
    proxied: rec.proxied,
    priority: rec.priority != null ? String(rec.priority) : "",
  };
}

interface Props {
  /** Bumped by the parent CloudflareSection whenever the user saves a new
   * API token, so this tab re-fetches with the new value instead of
   * staying on the stale one. */
  tokenVersion?: number;
}

/** Cloudflare DNS records — list, create, edit, delete. Scoped to one zone
 * at a time to keep the table simple; the zone selector at the top does the
 * switching. Token comes from Settings → Cloudflare; this section is
 * disabled with a hint when it's missing. */
export default function DnsSection({ tokenVersion = 0 }: Props = {}) {
  const [token, setToken] = useState<string | null>(null);
  const [zones, setZones] = useState<DnsZone[]>([]);
  const [zonesLoading, setZonesLoading] = useState(false);
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [selectedZoneId, setSelectedZoneId] = useState<string>("");

  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [editing, setEditing] = useState<DnsRecord | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Initial token fetch + re-fetch whenever the parent bumps tokenVersion
  // (i.e. the user saved a new token in the bar above the tabs).
  useEffect(() => {
    getCfApiToken().then((t) => setToken(t || ""));
  }, [tokenVersion]);

  const loadZones = useCallback(async (t: string) => {
    setZonesLoading(true);
    setZonesError(null);
    try {
      const list = await cfDnsListZones(t);
      setZones(list);
      // Auto-select the first zone so the records table is meaningful on first load.
      if (list.length > 0) setSelectedZoneId((prev) => prev || list[0].id);
    } catch (e) {
      setZonesError(e instanceof Error ? e.message : String(e));
    } finally {
      setZonesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) loadZones(token);
  }, [token, loadZones]);

  const loadRecords = useCallback(async (t: string, zoneId: string, q?: string) => {
    setRecordsLoading(true);
    setRecordsError(null);
    // Clear stale records on zone switch — user reported the lack of any
    // visual change when picking a different zone made it impossible to tell
    // whether the fetch was in progress or had silently failed.
    setRecords([]);
    try {
      const list = await cfDnsListRecords(t, zoneId, q);
      setRecords(list);
    } catch (e) {
      setRecordsError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token && selectedZoneId) loadRecords(token, selectedZoneId, search.trim() || undefined);
  }, [token, selectedZoneId, loadRecords]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search-driven reload — avoids spamming the API on each keystroke.
  useEffect(() => {
    if (!token || !selectedZoneId) return;
    const handle = window.setTimeout(() => {
      loadRecords(token, selectedZoneId, search.trim() || undefined);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [search, token, selectedZoneId, loadRecords]);

  const selectedZone = useMemo(() => zones.find((z) => z.id === selectedZoneId), [zones, selectedZoneId]);

  function startAdd() {
    setEditing(null);
    setForm({ ...blankForm });
    setSubmitError(null);
    setShowAdd(true);
  }

  function startEdit(rec: DnsRecord) {
    setEditing(rec);
    setForm(recordToForm(rec));
    setSubmitError(null);
    setShowAdd(true);
  }

  function cancelEdit() {
    setShowAdd(false);
    setEditing(null);
    setForm(blankForm);
    setSubmitError(null);
  }

  async function handleSubmit() {
    if (!token || !selectedZoneId) return;
    if (!form.name.trim() || !form.content.trim()) {
      setSubmitError("Name and content are required.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const input = formToInput(form);
      if (editing) {
        await cfDnsUpdateRecord(token, selectedZoneId, editing.id, input);
      } else {
        await cfDnsCreateRecord(token, selectedZoneId, input);
      }
      cancelEdit();
      await loadRecords(token, selectedZoneId, search.trim() || undefined);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(rec: DnsRecord) {
    if (!token || !selectedZoneId) return;
    if (!window.confirm(`Delete ${rec.record_type} record ${rec.name} → ${rec.content}?`)) return;
    setDeletingId(rec.id);
    try {
      await cfDnsDeleteRecord(token, selectedZoneId, rec.id);
      await loadRecords(token, selectedZoneId, search.trim() || undefined);
    } catch (e) {
      usePortaStore.getState().notifyError("Delete failed", e);
    } finally {
      setDeletingId(null);
    }
  }

  // Single source of truth for the add/edit form. Rendered either above the
  // table (Add mode) or inline directly under the row being edited (Edit
  // mode) so the user doesn't have to scroll up to a top-anchored panel
  // — mirrors how Cloudflare's own dashboard does it.
  function renderForm() {
    return (
      <div className="flex flex-col gap-3 p-4 rounded-card bg-[rgba(96,165,250,0.04)] border border-[rgba(96,165,250,0.18)]">
        <p className="text-[12px] font-medium text-ink">{editing ? "Edit record" : "New record"}</p>
        <div className="grid grid-cols-[110px_1fr_1fr] gap-2 items-start">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-ink-3">Type</span>
            <select
              value={form.recordType}
              onChange={(e) => setForm((p) => ({ ...p, recordType: e.target.value as RecordType }))}
              className="select-base !text-[12px] !py-1.5"
            >
              {RECORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-ink-3">Name</span>
            <input
              spellCheck={false}
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              placeholder={selectedZone ? `app.${selectedZone.name}` : "subdomain"}
              className="bg-surface-input border border-subtle rounded-control px-3 py-1.5 text-[12px] text-ink outline-none focus:border-[rgba(96,165,250,0.5)] font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-ink-3">Content</span>
            <input
              spellCheck={false}
              value={form.content}
              onChange={(e) => setForm((p) => ({ ...p, content: e.target.value }))}
              placeholder={form.recordType === "CNAME" ? "target.example.com" : form.recordType === "A" ? "192.0.2.1" : ""}
              className="bg-surface-input border border-subtle rounded-control px-3 py-1.5 text-[12px] text-ink outline-none focus:border-[rgba(96,165,250,0.5)] font-mono"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[11px] text-ink-2">
            TTL
            <select
              value={form.ttl}
              onChange={(e) => setForm((p) => ({ ...p, ttl: Number(e.target.value) }))}
              className="select-base !text-[11px] !py-1 !pl-2 !pr-6 !rounded w-[110px]"
            >
              <option value={1}>Auto</option>
              <option value={60}>1 min</option>
              <option value={300}>5 min</option>
              <option value={1800}>30 min</option>
              <option value={3600}>1 hour</option>
              <option value={86400}>1 day</option>
            </select>
          </label>
          {(form.recordType === "A" || form.recordType === "AAAA" || form.recordType === "CNAME") && (
            <label className="flex items-center gap-1.5 text-[11px] text-ink-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.proxied}
                onChange={(e) => setForm((p) => ({ ...p, proxied: e.target.checked }))}
                className="rounded border-strong bg-white/[0.05] text-warn focus:ring-[rgba(251,191,36,0.3)] focus:ring-offset-0"
              />
              Proxied (orange cloud)
            </label>
          )}
          {form.recordType === "MX" && (
            <label className="flex items-center gap-2 text-[11px] text-ink-2">
              Priority
              <input
                type="number"
                min={0}
                max={65535}
                value={form.priority}
                onChange={(e) => setForm((p) => ({ ...p, priority: e.target.value }))}
                className="bg-surface-input border border-subtle rounded px-2 py-1 text-[11px] text-ink outline-none focus:border-[rgba(96,165,250,0.5)] w-[80px]"
                placeholder="10"
              />
            </label>
          )}
        </div>
        {submitError && (
          <p className="text-[11px] text-bad font-mono whitespace-pre-wrap break-words">{submitError}</p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-3 py-1.5 text-[11.5px] rounded-control bg-accent-bg hover:bg-[rgba(96,165,250,0.25)] text-accent-ink border border-[rgba(96,165,250,0.3)] disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            {submitting && <span className="inline-block h-3 w-3 rounded-full border-2 border-[rgba(96,165,250,0.3)] border-t-accent animate-spin" />}
            {editing ? "Save changes" : "Create record"}
          </button>
          <button
            type="button"
            onClick={cancelEdit}
            disabled={submitting}
            className="px-3 py-1.5 text-[11.5px] rounded-control text-ink-2 hover:text-ink transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (token === null) {
    return <p className="text-[12px] text-ink-3">Loading…</p>;
  }

  if (!token) {
    return (
      <div className="max-w-2xl">
        <h2 className="text-[14px] font-semibold text-ink">DNS Records</h2>
        <p className="text-[11.5px] text-ink-3 mt-0.5">
          Manage DNS records in your Cloudflare zones — A, AAAA, CNAME, TXT, MX, NS.
        </p>
        <div className="mt-4 px-3 py-3 rounded-control bg-warn-bg border border-[rgba(251,191,36,0.25)] text-[12px] text-warn">
          Add a Cloudflare API token in the <span className="font-medium">Tunnels</span> tab first.
          Token needs <span className="font-mono">Zone:Read + DNS:Edit</span> scopes.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold text-ink">DNS Records</h2>
            {(recordsLoading || zonesLoading) && (
              <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-3">
                <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1.5A4.5 4.5 0 1 1 1.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                Loading{selectedZone ? ` ${selectedZone.name}` : ""}…
              </span>
            )}
          </div>
          <p className="text-[11.5px] text-ink-3 mt-0.5">
            Records in your Cloudflare zones. Edits sync to Cloudflare immediately.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!token) return;
            // Reload zones too — user may have added a new zone in the CF
            // dashboard since the section first mounted.
            loadZones(token);
            if (selectedZoneId) loadRecords(token, selectedZoneId, search.trim() || undefined);
          }}
          disabled={!token || recordsLoading || zonesLoading}
          className="text-[11px] text-ink-3 hover:text-ink disabled:opacity-40 transition-colors"
        >
          {recordsLoading || zonesLoading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      <div className="mt-5 flex flex-col gap-4">
        {/* Zone selector */}
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-[11px] font-medium text-ink-2">Zone</label>
          <div className="min-w-[220px]">
            <select
              value={selectedZoneId}
              onChange={(e) => setSelectedZoneId(e.target.value)}
              disabled={zonesLoading || zones.length === 0}
              className="select-base !text-[12px] !py-1.5"
            >
              {zones.length === 0 && <option value="">No zones</option>}
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </div>
          {selectedZone && (
            <span className="text-[10px] text-ink-3 font-mono">{selectedZone.status}</span>
          )}
          <input
            spellCheck={false}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name…"
            className="ml-auto bg-surface-input border border-subtle rounded-control px-3 py-1.5 text-[12px] text-ink outline-none focus:border-[rgba(96,165,250,0.5)] transition-colors w-[200px]"
          />
          <button
            type="button"
            onClick={startAdd}
            disabled={!selectedZoneId}
            className="px-3 py-1.5 text-[11.5px] rounded-control bg-accent-bg hover:bg-[rgba(96,165,250,0.25)] text-accent-ink border border-[rgba(96,165,250,0.3)] transition-colors disabled:opacity-40"
          >
            + Add record
          </button>
        </div>

        {zonesError && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-control bg-bad-bg border border-[rgba(248,113,113,0.25)]">
            <p className="text-[11px] text-bad font-mono whitespace-pre-wrap break-words flex-1">{zonesError}</p>
            <button
              type="button"
              onClick={() => token && loadZones(token)}
              disabled={zonesLoading}
              className="text-[10.5px] text-bad hover:text-bad underline disabled:opacity-40 shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* Add form lives here (above the table). Edit form is rendered
            inline below the row being edited — see records.map() below. */}
        {showAdd && !editing && renderForm()}

        {/* Records table — uses min-content + horizontal scroll fallback so
            long CNAME targets/UUIDs stay readable instead of being truncated
            into uselessness. The container has overflow-x-auto so on a very
            narrow viewport the table scrolls rather than crushes columns. */}
        <div className="rounded-card border border-subtle bg-surface-1 overflow-x-auto">
          <div className="min-w-[820px]">
            <div className="grid grid-cols-[64px_minmax(180px,1fr)_minmax(280px,2fr)_64px_88px_120px] gap-3 px-3 py-2 text-[10px] uppercase tracking-wider text-ink-3 border-b border-subtle">
              <div>Type</div>
              <div>Name</div>
              <div>Content</div>
              <div>TTL</div>
              <div>Proxied</div>
              <div className="text-right">Actions</div>
            </div>
            {recordsLoading && records.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-ink-3">Loading records…</div>
            ) : records.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-ink-3">
                {search.trim() ? "No records match." : "No records in this zone yet."}
              </div>
            ) : (
              records.map((rec) => {
                const isEditingThis = editing?.id === rec.id;
                return (
                  <div key={rec.id} className="border-b border-white/[0.04] last:border-0">
                    <div
                      className={`grid grid-cols-[64px_minmax(180px,1fr)_minmax(280px,2fr)_64px_88px_120px] gap-3 px-3 py-2 items-center text-[12px] text-ink hover:bg-white/[0.02] ${
                        isEditingThis ? "bg-[rgba(96,165,250,0.04)]" : ""
                      }`}
                    >
                      <div className="font-mono text-[11px] text-ink-2">{rec.record_type}</div>
                      <div className="font-mono min-w-0 truncate" title={rec.name}>{rec.name}</div>
                      <div className="font-mono text-ink-2 min-w-0 truncate" title={rec.content}>{rec.content}</div>
                      <div className="text-[11px] text-ink-3">{rec.ttl === 1 ? "Auto" : rec.ttl}</div>
                      <div>
                        {rec.proxied ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-warn-bg text-warn border border-[rgba(251,191,36,0.3)]">Proxied</span>
                        ) : (
                          <span className="text-[10px] text-ink-3">DNS only</span>
                        )}
                      </div>
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => isEditingThis ? cancelEdit() : startEdit(rec)}
                          className="px-2 py-0.5 text-[11px] rounded text-ink-2 hover:text-ink hover:bg-white/[0.06] transition-colors"
                        >
                          {isEditingThis ? "Close" : "Edit"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(rec)}
                          disabled={deletingId === rec.id}
                          className="px-2 py-0.5 text-[11px] rounded text-bad hover:text-bad hover:bg-bad-bg transition-colors disabled:opacity-40"
                        >
                          {deletingId === rec.id ? "…" : "Delete"}
                        </button>
                      </div>
                    </div>
                    {isEditingThis && (
                      <div className="px-3 pb-3 pt-1 bg-[rgba(96,165,250,0.02)]">
                        {renderForm()}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {recordsError && (
          <p className="text-[11px] text-bad font-mono whitespace-pre-wrap">{recordsError}</p>
        )}
      </div>
    </div>
  );
}
