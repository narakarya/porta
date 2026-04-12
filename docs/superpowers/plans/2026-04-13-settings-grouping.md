# Settings Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split AppSettingsModal General tab into General + Domain, and add a Domains tab to the global SettingsPage.

**Architecture:** Two independent UI-only changes — no new backend commands required. `AppSettingsModal` gains a 5th tab "Domain" containing subdomain fields. `SettingsPage` gains a "Domains" tab using the existing `updateWorkspace(id, name, domain)` store action.

**Tech Stack:** React, TypeScript, Tailwind (inline classes pattern used throughout this codebase)

---

## File Map

| File | Change |
|------|--------|
| `src/components/AppSettingsModal.tsx` | Add `"domain"` to `Section` type; add Domain tab to NAV; move Subdomain/Extra Subdomains/URL Preview JSX from `general` section to new `domain` section; keep Port in General |
| `src/components/SettingsPage.tsx` | Add `"domains"` to `Section` type; add Domains nav item; add `DomainsSection` component that lists workspaces with inline domain editing and Reload Caddy button |

---

## Task 1: Add Domain tab to AppSettingsModal

**Files:**
- Modify: `src/components/AppSettingsModal.tsx`

- [ ] **Step 1: Add `"domain"` to the Section type and NAV array**

In `src/components/AppSettingsModal.tsx`, change line 7:

```typescript
type Section = "general" | "domain" | "environment" | "tunneling" | "danger";
```

Then update the NAV array (around line 132) to insert the Domain entry after General:

```typescript
const NAV: { id: Section; label: string }[] = [
  { id: "general",     label: "General" },
  { id: "domain",      label: "Domain" },
  { id: "environment", label: "Environment" },
  { id: "tunneling",   label: "Tunneling" },
  { id: "danger",      label: "Danger Zone" },
];
```

- [ ] **Step 2: Clean up the General section — remove subdomain fields, keep Port**

In the `section === "general"` JSX block, remove the following fields (leave everything else intact):
- `<Field label="Subdomain" ...>` block (including the wildcard hint paragraph)
- `<Field label="Extra Subdomains" ...>` block (including tag list and add input)
- The `{/* URL Preview */}` card block

After removal, General section card should contain only: Name, Port, Start Command, Root Directory, Health Check Path.

Port's `<Field label="Port" ...>` block is already in General — leave it exactly where it is, no change needed.

- [ ] **Step 3: Add the Domain section JSX**

After the closing `</>` of the `section === "general"` block, add a new block:

```tsx
{section === "domain" && (
  <>
    <div>
      <h1 className="text-[16px] font-semibold text-zinc-100">Domain</h1>
      <p className="text-[12px] text-zinc-500 mt-1">Subdomains and local HTTPS URLs for this app.</p>
    </div>

    <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
      <Field label="Subdomain" hint={subdomain && !subdomainValid ? "Lowercase letters, numbers, hyphens, or *" : undefined}>
        <input value={subdomain} onChange={(e) => setSubdomain(e.target.value)}
          className={`input-base ${subdomain && !subdomainValid ? "border-red-500/50" : ""}`}
          placeholder={app.name} />
        <p className="text-[10px] text-zinc-600 mt-1">
          Use <code className="text-zinc-500">*</code> for wildcard (any subdomain)
        </p>
      </Field>

      <Field label="Extra Subdomains" hint={extraSubdomainInput && !extraSubdomainInputValid ? "Lowercase letters, numbers, hyphens only" : undefined}>
        {extraSubdomains.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {extraSubdomains.map((sub) => (
              <span key={sub} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/[0.07] border border-white/[0.10] text-[11px] font-mono text-zinc-300">
                {sub}
                <button
                  type="button"
                  onClick={() => setExtraSubdomains((prev) => prev.filter((s) => s !== sub))}
                  className="text-zinc-600 hover:text-red-400 transition-colors ml-0.5"
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                    <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            value={extraSubdomainInput}
            onChange={(e) => setExtraSubdomainInput(e.target.value.toLowerCase())}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addExtraSubdomain(); } }}
            className={`input-base flex-1 font-mono text-[12px] ${extraSubdomainInput && !extraSubdomainInputValid ? "border-red-500/50" : ""}`}
            placeholder="admin, platform, ..."
          />
          <button
            type="button"
            onClick={addExtraSubdomain}
            disabled={!extraSubdomainInput || !extraSubdomainInputValid}
            className="px-3 py-2 text-[12px] text-zinc-400 bg-white/[0.05] border border-white/[0.08] rounded-lg hover:bg-white/[0.08] hover:text-zinc-200 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
          >
            Add
          </button>
        </div>
        <p className="text-[10px] text-zinc-600 mt-1">
          Each subdomain routes to the same port. Press <kbd className="text-zinc-500 font-sans">Enter</kbd> or comma to add.
        </p>
      </Field>

      {/* URL Preview */}
      <div className="flex flex-col gap-1.5 pt-1">
        <p className="text-[12px] font-medium text-zinc-400">URL Preview</p>
        <div className="flex flex-col gap-1 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/60 shrink-0" />
            <span className="text-[12px] font-mono text-zinc-300 truncate">{previewPrimary}</span>
            <span className="text-[10px] text-zinc-600 shrink-0">primary</span>
          </div>
          {previewExtras.map((url) => (
            <div key={url} className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
              <span className="text-[12px] font-mono text-zinc-500 truncate">{url}</span>
            </div>
          ))}
        </div>
      </div>
    </div>

    <div className="flex items-center gap-2">
      {saveError && <p className="text-[11px] text-red-400 flex-1">{saveError}</p>}
      <div className="flex gap-2 ml-auto">
        <button onClick={onClose} className="px-4 py-2 text-[13px] text-zinc-500 hover:text-zinc-200 rounded-lg transition-colors">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="px-4 py-2 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  </>
)}
```

- [ ] **Step 4: Verify build compiles**

```bash
cd /Users/nasrulgunawan/projects/narakarya/porta && npm run typecheck 2>&1 | tail -20
```

Expected: no TypeScript errors related to `AppSettingsModal.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/components/AppSettingsModal.tsx
git commit -m "feat: split Domain tab from General in AppSettingsModal"
```

---

## Task 2: Add Domains tab to SettingsPage

**Files:**
- Modify: `src/components/SettingsPage.tsx`

- [ ] **Step 1: Add `"domains"` to the Section type and NAV array**

In `src/components/SettingsPage.tsx`, change line 7:

```typescript
type Section = "setup" | "domains" | "notifications" | "backup" | "sync";
```

Then insert the Domains entry in the NAV array after `setup`:

```typescript
{
  id: "domains",
  label: "Domains",
  icon: (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M10 3c-2 2-3 4.5-3 7s1 5 3 7M10 3c2 2 3 4.5 3 7s-1 5-3 7M3 10h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
},
```

- [ ] **Step 2: Wire the Domains section in the content area**

In the `<main>` section (around line 111), add after the setup section render:

```tsx
{activeSection === "domains" && <DomainsSection />}
```

- [ ] **Step 3: Add the DomainsSection component**

Add this component at the bottom of `src/components/SettingsPage.tsx`, before the last closing brace:

```tsx
function DomainsSection() {
  const { workspaces, updateWorkspace } = usePortaStore();
  const [editId, setEditId] = useState<string | null>(null);
  const [editDomain, setEditDomain] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadLoading, setReloadLoading] = useState(false);
  const [reloadStatus, setReloadStatus] = useState<"idle" | "success" | "error">("idle");

  function startEdit(ws: { id: string; domain: string }) {
    setEditId(ws.id);
    setEditDomain(ws.domain);
    setSaveError(null);
  }

  async function handleSave(ws: { id: string; name: string }) {
    if (!editDomain.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateWorkspace(ws.id, ws.name, editDomain.trim());
      setEditId(null);
    } catch (e: unknown) {
      setSaveError(String(e).replace(/^Error: /, ""));
    } finally {
      setSaving(false);
    }
  }

  async function handleReloadCaddy() {
    setReloadLoading(true);
    setReloadStatus("idle");
    try {
      await reloadCaddy();
      setReloadStatus("success");
    } catch {
      setReloadStatus("error");
    } finally {
      setReloadLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Domains</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          Manage the local domain for each workspace. Changes require a Caddy reload to take effect.
        </p>
      </div>

      {workspaces.length === 0 ? (
        <p className="text-[13px] text-zinc-500">No workspaces yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {workspaces.map((ws) => (
            <div key={ws.id} className="flex flex-col gap-3 p-4 rounded-xl bg-white/[0.03] border border-white/[0.07]">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-zinc-200 truncate">{ws.name}</p>
                </div>
                {editId !== ws.id && (
                  <button
                    onClick={() => startEdit(ws)}
                    className="text-[11px] text-zinc-500 hover:text-zinc-200 transition-colors shrink-0"
                  >
                    Edit
                  </button>
                )}
              </div>

              {editId === ws.id ? (
                <div className="flex flex-col gap-2">
                  <input
                    value={editDomain}
                    onChange={(e) => setEditDomain(e.target.value)}
                    className="input-base font-mono text-[12px]"
                    placeholder="narakarya.test"
                    autoFocus
                  />
                  {saveError && <p className="text-[11px] text-red-400">{saveError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSave(ws)}
                      disabled={!editDomain.trim() || saving}
                      className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-40 transition-colors"
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => setEditId(null)}
                      className="px-3 py-1.5 text-[12px] text-zinc-500 hover:text-zinc-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-[12px] font-mono text-zinc-400">{ws.domain}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Reload Caddy */}
      <div className="flex flex-col gap-3 p-4 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div>
          <p className="text-[13px] font-medium text-zinc-200">Apply Changes</p>
          <p className="text-[12px] text-zinc-500 mt-0.5 leading-relaxed">
            After editing a domain, reload Caddy to update routing.
          </p>
        </div>
        {reloadStatus === "success" && (
          <p className="text-[12px] text-emerald-400">Caddy reloaded successfully.</p>
        )}
        {reloadStatus === "error" && (
          <p className="text-[12px] text-red-400">Failed to reload Caddy.</p>
        )}
        <button
          onClick={handleReloadCaddy}
          disabled={reloadLoading}
          className="self-start px-3 py-1.5 text-[12px] font-medium bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-50 text-zinc-300 rounded-lg transition-colors"
        >
          {reloadLoading ? "Reloading…" : "Reload Caddy"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify build compiles**

```bash
cd /Users/nasrulgunawan/projects/narakarya/porta && npm run typecheck 2>&1 | tail -20
```

Expected: no TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPage.tsx
git commit -m "feat: add Domains tab to SettingsPage for workspace domain management"
```

---

## Task 3: Manual verification

- [ ] **Step 1: Start the dev server**

```bash
cd /Users/nasrulgunawan/projects/narakarya/porta && npm run dev
```

- [ ] **Step 2: Verify AppSettingsModal**

Open any app's settings:
- General tab: Name, Port, Start Command, Root Dir, Health Check, Start After — no subdomain fields
- Domain tab: Subdomain input, Extra Subdomains tag input, URL Preview card
- Save from Domain tab works (changes persist after closing and reopening)
- Environment, Tunneling, Danger Zone tabs unchanged

- [ ] **Step 3: Verify SettingsPage**

Open Settings:
- "Domains" tab appears between Setup and Notifications
- All workspaces listed with their domain
- Edit + Save updates domain correctly
- Reload Caddy button works
