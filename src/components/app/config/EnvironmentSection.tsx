import EnvVarTable from "./EnvVarTable";
import { IconRemove, IconPlus } from "./icons";
import { useAppConfig } from "./AppConfigContext";

export default function EnvironmentSection() {
  const c = useAppConfig();
  // Docker/compose/static/proxy apps aren't spawned from a shell command, so a
  // per-profile command override has nothing to override.
  const isCommandless = c.app.kind === "docker" || c.app.kind === "compose"
    || c.app.kind === "static" || c.app.kind === "proxy";

  return (
    <>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-2">Environment</p>
        <p className="text-[12px] text-ink-3 mt-1">Environment variables and startup behavior.</p>
      </div>

      {/* Profile tab bar (mockup 20) — pills for Default + named
          profiles. Switch (click), rename (double-click), delete and
          add all reuse the existing profile state + handlers. */}
      <div className="flex flex-col gap-3 p-5 rounded-card bg-surface-1 border border-subtle">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => c.selectProfile(null)}
            className={`px-3 py-1 rounded-control text-[12px] font-medium transition-colors border ${c.activeProfileId === null ? "bg-accent-bg text-accent-ink border-transparent" : "text-ink-2 border-subtle hover:bg-surface-1 hover:text-ink"}`}
          >
            Default
          </button>
          {c.envProfiles.map((p) => {
            const active = p.id === c.activeProfileId;
            if (c.renamingProfileId === p.id) {
              return (
                <input
                  key={p.id}
                  spellCheck={false}
                  autoFocus
                  value={c.renameValue}
                  onChange={(e) => c.setRenameValue(e.target.value)}
                  onBlur={c.commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); c.commitRename(); }
                    if (e.key === "Escape") { c.setRenamingProfileId(null); c.setRenameValue(""); }
                  }}
                  className="input-base text-[12px] w-28 py-1"
                />
              );
            }
            return (
              <span
                key={p.id}
                className={`inline-flex items-center rounded-control text-[12px] font-medium transition-colors border ${active ? "bg-accent-bg text-accent-ink border-transparent" : "text-ink-2 border-subtle hover:bg-surface-1 hover:text-ink"}`}
              >
                <button
                  type="button"
                  onClick={() => c.selectProfile(p.id)}
                  onDoubleClick={() => { c.setRenamingProfileId(p.id); c.setRenameValue(p.name); }}
                  title="Click to switch · double-click to rename"
                  className={`pl-3 py-1 ${active ? "pr-1" : "pr-3"}`}
                >
                  {p.name}
                </button>
                {active && (
                  c.deleteProfileConfirm === p.id ? (
                    <span className="inline-flex items-center gap-1 pr-1.5">
                      <button type="button" onClick={() => c.deleteProfile(p.id)} className="px-1.5 py-0.5 text-[10px] font-medium text-bad bg-bad-bg rounded hover:brightness-110 transition">Delete</button>
                      <button type="button" onClick={() => c.setDeleteProfileConfirm(null)} className="text-[10px] text-ink-3 hover:text-ink-2 transition-colors">Cancel</button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => c.setDeleteProfileConfirm(p.id)}
                      title="Delete profile"
                      aria-label={`Delete ${p.name}`}
                      className="pr-2 pl-0.5 py-1 text-accent-ink hover:text-bad transition-colors"
                    >
                      <IconRemove />
                    </button>
                  )
                )}
              </span>
            );
          })}
          {c.showNewProfile ? (
            <span className="inline-flex items-center gap-1.5">
              <input spellCheck={false} value={c.newProfileName} onChange={(e) => c.setNewProfileName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") c.createProfile(); if (e.key === "Escape") { c.setShowNewProfile(false); c.setNewProfileName(""); } }}
                className="input-base text-[12px] w-32 py-1" placeholder="staging" autoFocus />
              <button type="button" onClick={c.createProfile} disabled={!c.newProfileName.trim()} className="px-2.5 py-1 text-[12px] font-medium bg-accent hover:brightness-110 text-white rounded-control disabled:opacity-40 transition-colors shrink-0">Add</button>
              <button type="button" onClick={() => { c.setShowNewProfile(false); c.setNewProfileName(""); }} className="text-[12px] text-ink-3 hover:text-ink transition-colors shrink-0">Cancel</button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => c.setShowNewProfile(true)}
              title="Add profile"
              aria-label="Add profile"
              className="inline-flex items-center justify-center w-6 h-6 rounded-control text-ink-3 hover:bg-white/[0.05] hover:text-ink transition-colors"
            >
              <IconPlus />
            </button>
          )}
          {/* Top-right action: append a blank inline env var row. */}
          <button
            type="button"
            onClick={() => c.setEnvVars((prev) => [...prev, { key: "", value: "" }])}
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent hover:brightness-110 transition shrink-0"
          >
            <IconPlus /> Add variable
          </button>
        </div>
        {c.activeProfileId && (
          <p className="text-[10px] text-accent-ink">Active profile will be used when starting the app.</p>
        )}
        {/* A profile switch only takes effect on the next spawn — the running
            process still has the old command and environment. */}
        {(c.app.status === "running" || c.app.status === "starting")
          && c.activeProfileId !== (c.app.active_profile_id ?? null) && (
          <p className="text-[10px] text-warn">Save, then restart {c.app.name} to run under this profile.</p>
        )}
      </div>

      {/* Per-profile run commands — how "run as prod" is expressed: the profile
          swaps the command and, if the mode needs compiling first, runs a build
          to completion before the server starts. Hidden on Default, which is
          the app's own Start Command in the General tab. */}
      {c.activeProfileId && !isCommandless && (
        <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
          <div>
            <p className="text-[13px] font-medium text-ink">Run commands</p>
            <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
              Only for this profile. Leave blank to use the app's own Start Command.
            </p>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-ink-2">Start command</span>
            <input
              spellCheck={false}
              value={c.profileStartCommand}
              onChange={(e) => c.setProfileStartCommand(e.target.value)}
              className="input-base font-mono text-[12px]"
              placeholder={c.app.start_command || "mix phx.server"}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-ink-2">Build command</span>
            <input
              spellCheck={false}
              value={c.profileBuildCommand}
              onChange={(e) => c.setProfileBuildCommand(e.target.value)}
              className="input-base font-mono text-[12px]"
              placeholder="npm run build"
            />
            <span className="text-[10px] text-ink-3 leading-relaxed">
              Runs to completion before the start command, with this profile's
              environment. A non-zero exit aborts the start.
            </span>
          </label>
        </div>
      )}

      {/* Key/value table for the active profile (mockup 20). */}
      <div className="flex flex-col gap-3 p-5 rounded-card bg-surface-1 border border-subtle">
        <EnvVarTable
          vars={c.envVars}
          onChange={c.setEnvVars}
          port={c.portNum || c.app.port}
          envFile={c.envFile}
          onImportFile={c.browseEnvFile}
          onClearFile={() => c.setEnvFile("")}
        />
      </div>

      {/* Startup behavior */}
      <div className="flex flex-col gap-5 p-5 rounded-card bg-surface-1 border border-subtle">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium text-ink">Auto-start on launch</p>
            <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
              Automatically start this app when Porta opens.
            </p>
          </div>
          <button
            onClick={() => c.setAutoStart((v) => !v)}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
              c.autoStart ? "bg-accent" : "bg-surface-2"
            }`}
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
              c.autoStart ? "left-[18px]" : "left-0.5"
            }`} />
          </button>
        </div>

        <div className="h-px bg-surface-2" />

        {/* Restart policy */}
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-[12px] font-medium text-ink-2">Restart Policy</p>
            <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
              What to do when this app exits unexpectedly.
            </p>
          </div>
          <div className="flex gap-2">
            {(["never", "on-failure", "always"] as const).map((policy) => (
              <button
                key={policy}
                onClick={() => c.setRestartPolicy(policy)}
                className={`flex-1 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                  c.restartPolicy === policy
                    ? "bg-accent-bg text-accent-ink border border-[rgba(96,165,250,0.30)]"
                    : "bg-surface-1 text-ink-2 border border-subtle hover:bg-white/[0.07]"
                }`}
              >
                {policy === "never" ? "Never" : policy === "on-failure" ? "On Failure" : "Always"}
              </button>
            ))}
          </div>
          {c.restartPolicy !== "never" && (
            <div className="flex items-center gap-3">
              <label className="text-[12px] text-ink-2 flex-1">Max retries</label>
              <input spellCheck={false}
                type="number"
                min={1}
                max={10}
                value={c.maxRetries}
                onChange={(e) => c.setMaxRetries(e.target.value)}
                className="input-base w-20 text-center"
              />
            </div>
          )}
        </div>

        {c.autoSleepSupported && (
          <>
            <div className="h-px bg-surface-2" />

            {/* Auto-sleep: stop when idle, wake transparently on next request */}
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[13px] font-medium text-ink">Auto-sleep when idle</p>
                  <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
                    Stop this app after a period with no HTTP requests to free RAM.
                    It wakes automatically the next time its domain is opened.
                  </p>
                </div>
                <button
                  onClick={() => c.setAutoSleepEnabled((v) => !v)}
                  className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
                    c.autoSleepEnabled ? "bg-accent" : "bg-surface-2"
                  }`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
                    c.autoSleepEnabled ? "left-[18px]" : "left-0.5"
                  }`} />
                </button>
              </div>
              {c.autoSleepEnabled && (
                <div className="flex items-center gap-3">
                  <label className="text-[12px] text-ink-2 flex-1">Idle timeout (minutes)</label>
                  <input spellCheck={false}
                    type="number"
                    min={1}
                    max={1440}
                    value={c.idleTimeoutMin}
                    onChange={(e) => c.setIdleTimeoutMin(e.target.value)}
                    className="input-base w-20 text-center"
                  />
                </div>
              )}
            </div>
          </>
        )}

        <div className="h-px bg-surface-2" />

        {/* Max upload size — per-app override of the proxy body limit */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium text-ink">Max upload size</p>
            <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
              Largest request body the proxy accepts for this app. Leave blank to
              use the global default; set <span className="text-ink-2">0</span> for
              unlimited. Larger uploads get a 413.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 mt-0.5">
            <input spellCheck={false}
              type="number"
              min={0}
              placeholder="default"
              value={c.maxUploadMb}
              onChange={(e) => c.setMaxUploadMb(e.target.value)}
              className="input-base w-24 text-center"
            />
            <span className="text-[12px] text-ink-3">MB</span>
          </div>
        </div>
      </div>
    </>
  );
}
