import Field from "../../shared/Field";
import YamlEditor from "../../shared/YamlEditor";
import { useAppConfig } from "./AppConfigContext";

function volumeTemplate(appName: string): string {
  const slug = appName.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") || "app";
  return `~/projects/docker/volumes/${slug}/data:/data`;
}

export default function GeneralSection() {
  const {
    app,
    name, setName, port, setPort,
    startCommand, setStartCommand,
    dockerImage, setDockerImage,
    dockerContainerPort, setDockerContainerPort,
    dockerArgs, setDockerArgs,
    dockerVolumes, setDockerVolumes,
    composeFile, setComposeFile,
    composeMode, setComposeMode,
    composeYaml, setComposeYaml,
    composeError,
    composeErrorLine,
    networkShare, setNetworkShare,
    healthCheckPath, setHealthCheckPath,
    dependsOn, setDependsOn,
    siblingApps,
    portValid,
    portCheckResult,
    browseRootDir,
    rootDir, setRootDir,
    isStatic, isDocker, isCompose, isProxy,
  } = useAppConfig();

  return (
    <>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-2">General</p>
        <p className="text-[12px] text-ink-3 mt-1">App identity and connection settings.</p>
      </div>

      <div className="flex flex-col gap-4 p-5 rounded-card bg-surface-1 border border-subtle">
        {isStatic && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)]">
            <span className="text-[10px] font-semibold tracking-wider text-accent-ink mt-0.5">STATIC</span>
            <p className="text-[11px] text-accent-ink">
              Caddy serves files directly from the root directory — no process,
              no port, no start command.
            </p>
          </div>
        )}
        {isDocker && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)]">
            <span className="text-[10px] font-semibold tracking-wider text-accent-ink mt-0.5">DOCKER</span>
            <p className="text-[11px] text-accent-ink">
              Porta runs container <code className="font-mono">porta-{app.id.slice(0, 8)}…</code>.
              Host port maps to the container port below.
            </p>
          </div>
        )}
        {isCompose && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)]">
            <span className="text-[10px] font-semibold tracking-wider text-accent-ink mt-0.5">COMPOSE</span>
            <p className="text-[11px] text-accent-ink">
              Porta runs <code className="font-mono">docker compose up/down</code> in project <code className="font-mono">porta-{app.id.slice(0, 8)}…</code>. Port should match what compose publishes.
            </p>
          </div>
        )}
        {isProxy && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-accent-bg border border-[rgba(96,165,250,0.30)]">
            <span className="text-[10px] font-semibold tracking-wider text-accent-ink mt-0.5">PROXY</span>
            <p className="text-[11px] text-accent-ink">
              Caddy reverse-proxies the domain to an existing local port. You run the upstream yourself — no folder, no command.
            </p>
          </div>
        )}
        <Field label="Name">
          <input spellCheck={false} value={name} onChange={(e) => setName(e.target.value)}
            className="input-base" placeholder="My App" />
        </Field>

        {!isStatic && (
          <Field label={isDocker ? "Host Port" : isCompose ? "Proxy Port" : isProxy ? "Upstream Port" : "Port"} hint={!portValid && port ? "Must be 1-65535" : undefined}>
            <input spellCheck={false} value={port} onChange={(e) => setPort(e.target.value)}
              className={`input-base ${!portValid && port ? "border-[rgba(248,113,113,0.5)]" : ""}`}
              placeholder="3000" type="number" min={1} max={65535} />
            {portCheckResult && portValid && (
              <p className={`text-[10px] mt-1 ${portCheckResult.available ? "text-ok" : "text-warn"}`}>
                {portCheckResult.available
                  ? "✓ Port available"
                  : `⚠ Port in use by ${portCheckResult.process_name ?? "unknown"} (PID ${portCheckResult.pid ?? "?"})`}
              </p>
            )}
          </Field>
        )}

        {isCompose && (
          <Field label="Compose Source">
            <div className="flex gap-1 bg-surface-1 border border-subtle rounded-lg p-1 mb-2">
              {(["paste", "file"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setComposeMode(m)}
                  className={`flex-1 px-3 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
                    composeMode === m ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {m === "paste" ? "Paste YAML" : "File on disk"}
                </button>
              ))}
            </div>
            {composeMode === "file" ? (
              <>
                <input spellCheck={false} value={composeFile} onChange={(e) => setComposeFile(e.target.value)}
                  className="input-base font-mono text-[12px]" placeholder="docker-compose.yml" />
                <p className="text-[10px] text-ink-3 mt-1">Relative to Root Directory, or absolute.</p>
              </>
            ) : (
              <>
                <YamlEditor
                  value={composeYaml}
                  onChange={setComposeYaml}
                  placeholder={`services:\n  app:\n    image: postgres:16\n    ports:\n      - "5432:5432"`}
                  rows={20}
                  errorLine={composeErrorLine}
                  errorMessage={composeError ?? undefined}
                />
                {composeError && (
                  <div className="mt-2 px-2.5 py-1.5 rounded-md bg-bad-bg border border-[rgba(248,113,113,0.3)] text-[11px] text-bad font-mono whitespace-pre-wrap break-words">
                    {composeError}
                  </div>
                )}
                <p className="text-[10px] text-ink-3 mt-1">
                  Porta manages <code className="font-mono">~/.porta/compose/&lt;id&gt;/docker-compose.yml</code>. Restart app after edits.
                </p>
              </>
            )}
          </Field>
        )}

        {isDocker && (
          <>
            <Field label="Image">
              <input spellCheck={false} value={dockerImage} onChange={(e) => setDockerImage(e.target.value)}
                className="input-base font-mono text-[12px]" placeholder="e.g. postgres:16" />
            </Field>
            <Field label="Container Port">
              <input spellCheck={false} value={dockerContainerPort} onChange={(e) => setDockerContainerPort(e.target.value)}
                className="input-base" placeholder="80" type="number" min={1} max={65535} />
              <p className="text-[10px] text-ink-3 mt-1">Internal port the container listens on.</p>
            </Field>
            <Field label="Volumes">
              <div className="flex flex-col gap-1.5">
                {dockerVolumes.map((v, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      spellCheck={false}
                      value={v}
                      onChange={(e) => setDockerVolumes((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                      placeholder="./data:/var/lib/data"
                      className="input-base flex-1 font-mono text-[12px]"
                    />
                    <button
                      type="button"
                      onClick={() => setDockerVolumes((prev) => prev.map((x, j) => (j === i ? volumeTemplate(name) : x)))}
                      className="px-2.5 text-ink-3 hover:text-ink border border-subtle rounded-lg text-[11px] shrink-0"
                      title={`Fill with ${volumeTemplate(name)}`}
                    >
                      base
                    </button>
                    <button
                      type="button"
                      onClick={() => setDockerVolumes((prev) => prev.filter((_, j) => j !== i))}
                      className="px-2.5 text-ink-3 hover:text-bad border border-subtle rounded-lg text-[14px] shrink-0"
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setDockerVolumes((prev) => [...prev, ""])}
                  className="self-start px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink border border-dashed border-strong rounded-md"
                >
                  + Add volume
                </button>
              </div>
              <p className="text-[10px] text-ink-3 mt-1">
                <code className="font-mono">source:target</code> — relative sources resolve against Root Directory.
              </p>
            </Field>
            <Field label="Extra Args">
              <input spellCheck={false} value={dockerArgs} onChange={(e) => setDockerArgs(e.target.value)}
                className="input-base font-mono text-[12px]" placeholder="-e DEBUG=true --network my-net" />
            </Field>
          </>
        )}

        {!isStatic && !isDocker && !isCompose && !isProxy && (
          <Field label="Start Command">
            <input spellCheck={false} value={startCommand} onChange={(e) => setStartCommand(e.target.value)}
              className="input-base font-mono text-[12px]" placeholder="mix phx.server" />
          </Field>
        )}

        {!isProxy && (
        <Field label={isDocker ? "Root Directory (optional)" : isCompose ? "Compose Project Folder" : "Root Directory"}>
          <div className="flex gap-2">
            <input
              spellCheck={false}
              value={rootDir}
              onChange={(e) => setRootDir(e.target.value)}
              className="input-base flex-1 font-mono text-[12px]"
              placeholder={isDocker ? "Base for relative volume paths" : isCompose ? "Folder containing compose file" : "/path/to/project"}
            />
            <button
              type="button"
              onClick={browseRootDir}
              className="px-3 py-2 text-[12px] text-ink-2 bg-surface-2 border border-subtle rounded-lg hover:bg-white/[0.08] hover:text-ink transition-colors shrink-0"
            >
              Browse
            </button>
          </div>
        </Field>
        )}

        {(isDocker || isCompose) && (
          <Field label="Workspace Network">
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={networkShare}
                onChange={(e) => setNetworkShare(e.target.checked)}
                className="mt-0.5 rounded border-strong bg-surface-2 text-accent focus:ring-[rgba(96,165,250,0.45)] focus:ring-offset-0"
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-[12px] text-ink">Join shared network</span>
                <span className="text-[11px] text-ink-3">
                  Network <code className="font-mono">{app.workspace_id ? `porta-ws-${app.workspace_id.slice(0, 8)}…` : "porta-standalone"}</code>.
                  Restart app to apply.
                </span>
              </div>
            </label>
          </Field>
        )}

        {!isStatic && (
          <Field label="Health Check Path">
            <input spellCheck={false} value={healthCheckPath} onChange={(e) => setHealthCheckPath(e.target.value)}
              className="input-base" placeholder="/health" />
            <p className="text-[10px] text-ink-3 mt-1">
              Leave blank to use port-only detection
            </p>
          </Field>
        )}
      </div>

      {/* Start After (dependencies) (from agent-a7a6ec3b) */}
      {siblingApps.length > 0 && (
        <div className="flex flex-col gap-3 p-5 rounded-card bg-surface-1 border border-subtle">
          <div>
            <p className="text-[12px] font-medium text-ink-2">Start After</p>
            <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
              Select apps that must be running before this app starts.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            {siblingApps.map((sibling) => {
              const checked = dependsOn.includes(sibling.id);
              return (
                <label
                  key={sibling.id}
                  className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] transition-colors cursor-pointer"
                >
                  <input spellCheck={false}
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setDependsOn((prev) =>
                        checked
                          ? prev.filter((id) => id !== sibling.id)
                          : [...prev, sibling.id]
                      )
                    }
                    className="rounded border-strong bg-surface-2 text-accent focus:ring-[rgba(96,165,250,0.45)] focus:ring-offset-0"
                  />
                  <span className="text-[13px] text-ink-2">{sibling.name}</span>
                  <span className="text-[11px] text-ink-3">:{sibling.port}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
