import { useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { usePortaStore } from "../store";
import type { App, Workspace } from "../types";

type Section = "general" | "environment" | "danger";

interface Props {
  app: App;
  workspace: Workspace | null;
  onClose: () => void;
}

export default function AppSettingsModal({ app, workspace, onClose }: Props) {
  const { updateApp, deleteApp } = usePortaStore();
  const [section, setSection] = useState<Section>("general");

  const [name, setName] = useState(app.name);
  const [port, setPort] = useState(String(app.port));
  const [subdomain, setSubdomain] = useState(app.subdomain ?? "");
  const [startCommand, setStartCommand] = useState(app.start_command);

  const [envFile, setEnvFile] = useState(app.env_file ?? "");
  const [autoStart, setAutoStart] = useState(app.auto_start);

  const [deleteTyped, setDeleteTyped] = useState("");
  const deleteInputRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const portNum = parseInt(port, 10);
  const portValid = !isNaN(portNum) && portNum > 0 && portNum < 65536;
  const subdomainValid = !subdomain || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^\*$/.test(subdomain);
  const canSave = name.trim() && portValid && subdomainValid;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateApp({
        id: app.id,
        name: name.trim(),
        port: portNum,
        subdomain: subdomain.trim() || null,
        start_command: startCommand.trim(),
        env_file: envFile.trim() || null,
        auto_start: autoStart,
      });
      onClose();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function browseEnvFile() {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: "Env files", extensions: ["env", "txt", "*"] }],
    }).catch(() => null);
    if (typeof selected === "string") setEnvFile(selected);
  }

  async function handleDelete() {
    if (deleteTyped !== app.name) return;
    await deleteApp(app.id);
    onClose();
  }

  const NAV: { id: Section; label: string }[] = [
    { id: "general",     label: "General" },
    { id: "environment", label: "Environment" },
    { id: "danger",      label: "Danger Zone" },
  ];

  return (
    <div className="fixed inset-0 bg-[#111113] text-zinc-100 font-sans flex h-screen overflow-hidden z-50">
      {/* Drag region */}
      <div className="drag-region fixed top-0 left-0 right-0 h-8 z-10 pointer-events-none" />

      {/* Sidebar */}
      <aside className="w-[200px] bg-[#1a1a1c] border-r border-white/[0.06] flex flex-col pt-8 pb-3 shrink-0">
        <div className="px-4 mb-4">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M7.5 2L3.5 6l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Back
          </button>
        </div>

        <div className="px-4 mb-1">
          <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest truncate">
            {app.name}
          </p>
        </div>
        <div className="px-4 mb-3">
          <p className="text-[11px] text-zinc-600 truncate">
            {workspace?.domain ?? "standalone"} · :{app.port}
          </p>
        </div>

        <nav className="flex-1 flex flex-col gap-0.5 px-2 overflow-auto no-drag">
          {NAV.map(({ id, label }) => {
            const active = section === id;
            return (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`flex items-center px-2 py-1.5 rounded-[6px] text-[13px] w-full text-left transition-all duration-100 ${
                  active
                    ? id === "danger" ? "bg-red-500/10 text-red-400" : "bg-white/10 text-zinc-100"
                    : id === "danger"
                    ? "text-red-500/60 hover:bg-red-500/[0.07] hover:text-red-400"
                    : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-auto pt-10 px-8 pb-8 no-drag flex flex-col">
        <div className="max-w-[520px] w-full flex flex-col gap-6">

          {section === "general" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-zinc-100">General</h1>
                <p className="text-[12px] text-zinc-500 mt-1">App identity and connection settings.</p>
              </div>

              <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <Field label="Name">
                  <input value={name} onChange={(e) => setName(e.target.value)}
                    className="input-base" placeholder="My App" />
                </Field>

                <Field label="Port" hint={!portValid && port ? "Must be 1–65535" : undefined}>
                  <input value={port} onChange={(e) => setPort(e.target.value)}
                    className={`input-base ${!portValid && port ? "border-red-500/50" : ""}`}
                    placeholder="3000" type="number" min={1} max={65535} />
                </Field>

                <Field label="Subdomain" hint={subdomain && !subdomainValid ? "Lowercase letters, numbers, hyphens, or *" : undefined}>
                  <input value={subdomain} onChange={(e) => setSubdomain(e.target.value)}
                    className={`input-base ${subdomain && !subdomainValid ? "border-red-500/50" : ""}`}
                    placeholder={app.name} />
                  <p className="text-[10px] text-zinc-600 mt-1">
                    Use <code className="text-zinc-500">*</code> for wildcard (any subdomain)
                  </p>
                </Field>

                <Field label="Start Command">
                  <input value={startCommand} onChange={(e) => setStartCommand(e.target.value)}
                    className="input-base font-mono text-[12px]" placeholder="mix phx.server" />
                </Field>

                <Field label="Root Directory">
                  <p className="text-[12px] text-zinc-400 font-mono truncate bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2">
                    {app.root_dir}
                  </p>
                </Field>
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
                    {saving ? "Saving…" : "Save Changes"}
                  </button>
                </div>
              </div>
            </>
          )}

          {section === "environment" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-zinc-100">Environment</h1>
                <p className="text-[12px] text-zinc-500 mt-1">Environment variables and startup behavior.</p>
              </div>

              <div className="flex flex-col gap-5 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <div className="flex flex-col gap-2">
                  <p className="text-[12px] font-medium text-zinc-300">.env File</p>
                  <p className="text-[11px] text-zinc-500 leading-relaxed">
                    Variables from this file are injected when the app starts.
                    Relative paths (e.g. <code className="text-zinc-400">.env</code>) resolve from the app's root directory.
                    <code className="text-zinc-400 ml-1">PORT</code> is always overridden by Porta's assigned port.
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={envFile}
                      onChange={(e) => setEnvFile(e.target.value)}
                      className="input-base flex-1 font-mono text-[12px]"
                      placeholder=".env"
                    />
                    <button
                      onClick={browseEnvFile}
                      className="px-3 py-2 text-[12px] text-zinc-400 bg-white/[0.05] border border-white/[0.08] rounded-lg hover:bg-white/[0.08] hover:text-zinc-200 transition-colors shrink-0"
                    >
                      Browse
                    </button>
                  </div>
                  {envFile && (
                    <button onClick={() => setEnvFile("")} className="self-start text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors">
                      Clear
                    </button>
                  )}
                </div>

                <div className="h-px bg-white/[0.05]" />

                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[13px] font-medium text-zinc-200">Auto-start on launch</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                      Automatically start this app when Porta opens.
                    </p>
                  </div>
                  <button
                    onClick={() => setAutoStart((v) => !v)}
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
                      autoStart ? "bg-blue-600" : "bg-zinc-700"
                    }`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
                      autoStart ? "left-[18px]" : "left-0.5"
                    }`} />
                  </button>
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
                    {saving ? "Saving…" : "Save Changes"}
                  </button>
                </div>
              </div>
            </>
          )}

          {section === "danger" && (
            <>
              <div>
                <h1 className="text-[16px] font-semibold text-zinc-100">Danger Zone</h1>
                <p className="text-[12px] text-zinc-500 mt-1">Irreversible actions — proceed carefully.</p>
              </div>

              <div className="flex flex-col gap-3 p-5 rounded-xl bg-red-500/[0.04] border border-red-500/20">
                <div>
                  <p className="text-[13px] font-semibold text-red-400">Delete this app</p>
                  <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                    Removes the app from Porta. The files on disk won't be deleted.
                  </p>
                </div>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-zinc-500">
                    Type <span className="text-zinc-300 font-mono">{app.name}</span> to confirm
                  </span>
                  <input
                    ref={deleteInputRef}
                    value={deleteTyped}
                    onChange={(e) => setDeleteTyped(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleDelete()}
                    placeholder={app.name}
                    className="input-base focus:border-red-500/60"
                    autoComplete="off"
                  />
                </label>
                <button
                  onClick={handleDelete}
                  disabled={deleteTyped !== app.name}
                  className="self-start px-4 py-2 text-[13px] font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg disabled:opacity-40 transition-colors"
                >
                  Delete App
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[12px] font-medium text-zinc-400">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-red-400">{hint}</p>}
    </div>
  );
}
