import { useEffect, useState } from "react";
import { previewPortaConfig, importPortaConfig } from "../../lib/commands";
import type { AdoptPreview, AdoptAppPreview } from "../../lib/commands";
import { usePortaStore } from "../../store";
import ModalWrapper from "../shared/ModalWrapper";
import { Button, Spinner } from "../ui";

interface Props {
  /** Path to the `.porta.yml` being adopted. */
  configPath: string;
  onClose: () => void;
  /** Fires only on a successful import — not when the user backs out. */
  onImported?: () => void;
}

/** Last path segment, for showing a folder without the full absolute path. */
function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/**
 * Confirmation step for adopting a project's `.porta.yml`. Import used to be a
 * blind action — it created a second workspace every time and dropped apps
 * whose port was taken without saying so. This shows the plan first: which
 * workspace the apps land in, which ports move, and what is already set up.
 */
export default function AdoptProjectModal({ configPath, onClose, onImported }: Props) {
  const { load, selectWorkspace, notify, notifyError } = usePortaStore();

  const [preview, setPreview] = useState<AdoptPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  /** null until the preview lands, then defaults to the existing workspace. */
  const [intoExisting, setIntoExisting] = useState(true);
  const [reassignPorts, setReassignPorts] = useState(true);

  useEffect(() => {
    let cancelled = false;
    previewPortaConfig(configPath)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setIntoExisting(p.existing_workspace_id !== null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [configPath]);

  const apps = preview?.apps ?? [];
  const conflicts = apps.filter((a) => a.status === "port_taken");
  const duplicates = apps.filter((a) => a.status === "duplicate");
  // What actually gets created if the user hits Import with the current
  // choices — conflicts only count when they can be moved somewhere.
  const willImport = apps.filter(
    (a) =>
      a.status === "new" ||
      (a.status === "port_taken" && reassignPorts && a.suggested_port !== null)
  );

  async function handleImport() {
    if (!preview) return;
    setImporting(true);
    try {
      const summary = await importPortaConfig(preview.config_path, {
        workspaceId: intoExisting ? preview.existing_workspace_id : null,
        reassignPorts,
      });
      await load();
      selectWorkspace(summary.workspace_id);
      const skipped = summary.skipped.length;
      notify({
        kind: skipped > 0 ? "info" : "success",
        message:
          summary.imported.length > 0
            ? `Added ${summary.imported.length} app${summary.imported.length === 1 ? "" : "s"} to ${summary.workspace_name}`
            : `Nothing to add to ${summary.workspace_name}`,
        detail:
          skipped > 0
            ? summary.skipped.map((s) => `${s.name}: ${s.reason}`).join("\n")
            : null,
      });
      onImported?.();
      onClose();
    } catch (e) {
      notifyError("Could not set up the project", e);
      setImporting(false);
    }
  }

  return (
    <ModalWrapper
      onClose={onClose}
      className="bg-surface-2 border border-subtle rounded-card shadow-2xl max-h-[90vh] overflow-y-auto"
    >
      <div className="p-6 w-[540px] flex flex-col gap-5">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Set up this project</h2>
          <p className="text-[12px] text-ink-3 mt-0.5">
            <code className="font-mono">{basename(configPath)}</code> describes a
            workspace and the apps that run in it.
          </p>
        </div>

        {error && (
          <div className="px-3 py-2 bg-bad-bg border border-[var(--danger-border)] rounded-control text-[12px] text-bad">
            {error}
          </div>
        )}

        {!preview && !error && (
          <div className="flex items-center gap-2 py-6 justify-center text-[12px] text-ink-3">
            <Spinner size={14} />
            Reading config…
          </div>
        )}

        {preview && (
          <>
            {/* Where the apps land */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-ink-3">Workspace</span>
              {preview.existing_workspace_id ? (
                <div className="flex flex-col gap-1">
                  <TargetOption
                    checked={intoExisting}
                    onSelect={() => setIntoExisting(true)}
                    title={`Add to “${preview.existing_workspace_name}”`}
                    detail={`Already on ${preview.workspace_domain}`}
                  />
                  <TargetOption
                    checked={!intoExisting}
                    onSelect={() => setIntoExisting(false)}
                    title={`Create “${preview.workspace_name}”`}
                    detail={`A second workspace answering for ${preview.workspace_domain}`}
                  />
                </div>
              ) : (
                <div className="px-3 py-2 bg-surface-1 border border-subtle rounded-control">
                  <div className="text-[13px] text-ink">{preview.workspace_name}</div>
                  <div className="text-[11px] text-ink-3 font-mono mt-0.5">
                    {preview.workspace_domain}
                  </div>
                </div>
              )}
            </div>

            {/* Apps */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-ink-3">
                  Apps ({apps.length})
                </span>
                <span className="text-[10px] text-ink-3">
                  {willImport.length} will be added
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {apps.map((app) => (
                  <AppRow key={app.name} app={app} reassignPorts={reassignPorts} />
                ))}
              </div>
            </div>

            {conflicts.length > 0 && (
              <label className="flex items-start gap-2.5 px-3 py-2.5 bg-surface-1 border border-subtle rounded-control cursor-pointer">
                <input
                  type="checkbox"
                  checked={reassignPorts}
                  onChange={(e) => setReassignPorts(e.target.checked)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span className="text-[12px] text-ink-2">
                  Move clashing ports to free ones
                  <span className="block text-[11px] text-ink-3 mt-0.5">
                    {conflicts.length} app{conflicts.length === 1 ? "" : "s"} want a
                    port something else already holds. Unchecked, they are skipped.
                  </span>
                </span>
              </label>
            )}

            {duplicates.length > 0 && (
              <p className="text-[11px] text-ink-3">
                {duplicates.length} folder{duplicates.length === 1 ? " is" : "s are"}{" "}
                already set up in Porta and will be left alone.
              </p>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            loading={importing}
            disabled={!preview || willImport.length === 0}
          >
            {importing
              ? "Setting up…"
              : `Add ${willImport.length} app${willImport.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </ModalWrapper>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function TargetOption({
  checked,
  onSelect,
  title,
  detail,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      className={`flex items-start gap-2.5 px-3 py-2 rounded-control border cursor-pointer transition-colors duration-fast ${
        checked ? "bg-accent-bg border-[var(--accent-border)]" : "bg-surface-1 border-subtle"
      }`}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 accent-[var(--accent)]"
      />
      <span className="min-w-0">
        <span className="block text-[13px] text-ink truncate">{title}</span>
        <span className="block text-[11px] text-ink-3 mt-0.5">{detail}</span>
      </span>
    </label>
  );
}

function AppRow({
  app,
  reassignPorts,
}: {
  app: AdoptAppPreview;
  reassignPorts: boolean;
}) {
  const skipped =
    app.status === "duplicate" ||
    (app.status === "port_taken" && (!reassignPorts || app.suggested_port === null));

  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-2 bg-surface-1 border border-subtle rounded-control ${
        skipped ? "opacity-50" : ""
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] text-ink truncate">{app.name}</span>
          <span className="text-[10px] text-ink-3 font-mono truncate">
            {basename(app.root_dir)}
          </span>
        </div>
        <div className="text-[10px] text-ink-3 font-mono truncate mt-0.5">
          {app.start_command}
        </div>
      </div>
      <PortTag app={app} reassignPorts={reassignPorts} />
    </div>
  );
}

function PortTag({
  app,
  reassignPorts,
}: {
  app: AdoptAppPreview;
  reassignPorts: boolean;
}) {
  if (app.status === "duplicate") {
    return (
      <span
        className="text-[10px] text-ink-3 shrink-0"
        title={`Already added as “${app.existing_app}”`}
      >
        already added
      </span>
    );
  }
  if (app.status === "port_taken") {
    if (app.suggested_port === null) {
      return <span className="text-[10px] text-bad shrink-0">no free port</span>;
    }
    if (!reassignPorts) {
      return (
        <span className="text-[10px] text-warn font-mono shrink-0">
          :{app.port} taken
        </span>
      );
    }
    return (
      <span className="text-[10px] font-mono shrink-0 text-warn">
        <span className="line-through opacity-60">:{app.port}</span>{" "}
        <span className="text-ink-2">→ :{app.suggested_port}</span>
      </span>
    );
  }
  return <span className="text-[10px] text-ink-3 font-mono shrink-0">:{app.port}</span>;
}
