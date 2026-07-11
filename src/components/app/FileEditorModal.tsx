import { useCallback, useEffect, useRef, useState } from "react";
import {
  listAppConfigFiles,
  readConfigFile,
  writeConfigFile,
  createConfigFromTemplate,
  loadComposeYaml,
  saveComposeYaml,
  parseDockerCompose,
  updateApp,
  type ConfigFileInfo,
} from "../../lib/commands";
import { usePortaStore } from "../../store";
import YamlEditor from "../shared/YamlEditor";
import CodeEditor, { type CodeLanguage } from "../shared/CodeEditor";
import EditorSearchBar from "../shared/EditorSearchBar";
import { SearchQuery, setSearchQuery, findNext, findPrevious, SearchCursor } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";

type FileKind = "compose" | "env" | "generic";

interface FileEntry {
  path: string;
  name: string;
  kind: FileKind;
  /** Syntax language for generic (code-editor) files. */
  language?: CodeLanguage;
  size?: number;
  modified_at?: number | null;
  /** Absolute path this template would create, if that target doesn't exist yet. */
  templateTarget?: string | null;
}

function baseName(path: string): string {
  return path.split("/").pop() || path;
}

interface Props {
  appId: string;
  appName: string;
  composePath: string | null;
  currentPort: number;
  onClose: () => void;
  initialPath?: string;
}

// ── Env row types ────────────────────────────────────────────────────────────

type EnvRow =
  | { kind: "comment"; raw: string }
  | { kind: "var"; key: string; value: string; raw: string };

const SECRET_KEY_RE = /SECRET|PASS|PWD|TOKEN|KEY|API|AUTH|BEARER|SALT|CRED|JWT|HASH|SIGN|PRIVATE|HMAC|CIPHER/i;

function parseEnvContent(content: string): EnvRow[] {
  return content.split("\n").map((line): EnvRow => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      return { kind: "comment", raw: line };
    }
    let rest = trimmed;
    if (rest.startsWith("export ")) rest = rest.slice(7).trimStart();
    const eqIdx = rest.indexOf("=");
    if (eqIdx < 0) return { kind: "comment", raw: line };
    const key = rest.slice(0, eqIdx).trim();
    let value = rest.slice(eqIdx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return { kind: "var", key, value, raw: line };
  });
}

function needsQuoting(value: string): boolean {
  return /[\s"'`$\\#]/.test(value);
}

function serializeRows(rows: EnvRow[]): string {
  return rows
    .map((row) => {
      if (row.kind === "comment") return row.raw;
      const v = needsQuoting(row.value) ? `"${row.value.replace(/"/g, '\\"')}"` : row.value;
      return `${row.key}=${v}`;
    })
    .join("\n");
}

function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** A variable that has a name but no value yet. Rows with no name are still
 *  being typed, so they aren't flagged. */
function needsValue(row: EnvRow): boolean {
  return row.kind === "var" && row.key !== "" && row.value === "";
}

const SECRET_MASK = "••••••••";

// Mask the values of sensitive KEY=VALUE lines for the raw view, leaving
// comments, blank lines, and non-sensitive vars untouched.
function maskRawSecrets(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const eq = line.indexOf("=");
      if (eq < 0) return line;
      const key = line.slice(0, eq).replace(/^\s*export\s+/, "").trim();
      const val = line.slice(eq + 1);
      if (!isSensitiveKey(key) || val === "") return line;
      return `${line.slice(0, eq + 1)}${SECRET_MASK}`;
    })
    .join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAgo(epochSec: number | null | undefined): string {
  if (!epochSec) return "—";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function FileEditorModal({ appId, appName, composePath, currentPort, onClose, initialPath }: Props) {
  const restartApp = usePortaStore((s) => s.restartApp);
  const apps = usePortaStore((s) => s.apps);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  // compose state
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");

  // env state
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [originalRows, setOriginalRows] = useState<EnvRow[]>([]);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  // Global reveal — overrides per-row masking so every sensitive value shows at
  // once. Individual eye toggles still work when this is off.
  const [showAllSensitive, setShowAllSensitive] = useState(false);
  const [envMode, setEnvMode] = useState<"rows" | "raw">("rows");
  const [rawContent, setRawContent] = useState("");

  // Rows mode undo/redo history (serialized snapshots)
  const rowsHistoryRef = useRef<string[]>([]);
  const rowsHistoryIdxRef = useRef<number>(-1);
  // Saved history snapshot from before entering raw mode — restored on switch back
  const rowsHistorySavedRef = useRef<string[]>([]);
  const rowsHistoryIdxSavedRef = useRef<number>(-1);

  // Raw mode undo/redo history
  const rawHistoryRef = useRef<string[]>([]);
  const rawHistoryIdxRef = useRef<number>(-1);
  const rawDebounceRef = useRef<number | null>(null);
  const rowsRef = useRef<EnvRow[]>([]);
  // Keep rowsRef in sync so callbacks always see fresh rows without stale closure
  rowsRef.current = rows;

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<number | undefined>(undefined);
  const [restartPrompt, setRestartPrompt] = useState<{ oldPort: number; newPort: number } | null>(null);
  const [fileMissing, setFileMissing] = useState(false);
  const [relinking, setRelinking] = useState(false);
  /** Target path currently being created, so its button can show progress. */
  const [creating, setCreating] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  // Find-in-file search (compose + generic editors)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQueryState] = useState("");
  const [matchInfo, setMatchInfo] = useState<{ index: number; count: number }>({ index: -1, count: 0 });
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchViewRef = useRef<EditorView | null>(null);

  const active = files.find((f) => f.path === activePath) ?? null;
  /** Templates whose target is still missing. Backend only sets the field in
   *  that case, so this list empties itself once the file is created. */
  const templateCandidates = files.filter((f) => f.templateTarget);
  /** A declared key with an empty value is the single signal for "you still need
   *  to fill this in", whether it came from blanking a template's secret or was
   *  empty already. A row with no key yet is one the user is still typing (see
   *  `addRow`), so it doesn't count. */
  const emptyValueCount = rows.filter((r) => r.kind === "var" && needsValue(r)).length;
  const isDirty = active?.kind === "env"
    ? envMode === "raw"
      ? rawContent !== serializeRows(originalRows)
      : JSON.stringify(rows) !== JSON.stringify(originalRows)
    : content !== originalContent;

  const showToast = useCallback((ok: boolean, msg: string) => {
    setToast({ ok, msg });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  const refreshList = useCallback(async (): Promise<FileEntry[]> => {
    const next: FileEntry[] = [];
    if (composePath) {
      const segs = composePath.split("/");
      next.push({ path: composePath, name: segs[segs.length - 1] || composePath, kind: "compose" });
    }
    try {
      const configs: ConfigFileInfo[] = await listAppConfigFiles(appId);
      for (const c of configs) {
        next.push({
          path: c.path,
          name: c.name,
          kind: c.kind,
          language: c.kind === "generic" ? (c.language as CodeLanguage) : undefined,
          size: c.size,
          modified_at: c.modified_at ?? null,
          templateTarget: c.template_target ?? null,
        });
      }
    } catch { /* non-fatal */ }
    setFiles(next);
    return next;
  }, [appId, composePath]);

  const loadEntry = useCallback(async (entry: FileEntry) => {
    setActivePath(entry.path);
    setLoading(true);
    setError(null);
    setErrorLine(undefined);
    setFileMissing(false);
    setRestartPrompt(null);
    setRevealed({});
    setEnvMode("rows");
    setRawContent("");
    try {
      if (entry.kind === "compose") {
        const [text, proj] = await Promise.all([
          loadComposeYaml(entry.path),
          parseDockerCompose(entry.path).catch(() => null),
        ]);
        setContent(text);
        setOriginalContent(text);
        if (proj) {
          let firstHostPort: number | null = null;
          for (const svc of proj.services) {
            for (const [host] of svc.ports) {
              firstHostPort = host;
              break;
            }
            if (firstHostPort != null) break;
          }
          if (firstHostPort != null && firstHostPort !== currentPort) {
            setRestartPrompt({ oldPort: currentPort, newPort: firstHostPort });
          }
        }
      } else if (entry.kind === "generic") {
        const text = await readConfigFile(entry.path);
        setContent(text);
        setOriginalContent(text);
      } else {
        const text = await readConfigFile(entry.path);
        const parsed = parseEnvContent(text);
        setRows(parsed);
        setOriginalRows(parsed);
        rowsHistoryRef.current = [serializeRows(parsed)];
        rowsHistoryIdxRef.current = 0;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (entry.kind === "compose" && /no such file|os error 2|cannot find/i.test(msg)) {
        setFileMissing(true);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [currentPort]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await refreshList();
      if (cancelled || list.length === 0) return;
      const target = (initialPath && list.find((f) => f.path === initialPath)) || list[0];
      void loadEntry(target);
    })();
    return () => { cancelled = true; };
  }, [refreshList, loadEntry, initialPath]);

  const attemptClose = useCallback(() => {
    if (isDirty) {
      const ok = window.confirm("You have unsaved changes. Discard and close?");
      if (!ok) return;
    }
    onClose();
  }, [isDirty, onClose]);

  // ── Find-in-file search (CodeMirror editors) ────────────────────────────

  // Push a query into a CodeMirror view and report match position/count.
  function applyCmSearch(view: EditorView, q: string): { index: number; count: number } {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: q, caseSensitive: false })) });
    if (q === "") return { index: -1, count: 0 };
    const doc = view.state.doc;
    let count = 0;
    let index = -1;
    const head = view.state.selection.main.from;
    const cursor = new SearchCursor(doc, q, 0, doc.length, (x) => x.toLowerCase());
    while (!cursor.next().done) {
      if (index === -1 && cursor.value.from >= head) index = count;
      count++;
    }
    if (index === -1 && count > 0) index = 0;
    return { index, count };
  }

  useEffect(() => {
    const view = searchViewRef.current;
    if (!view || active?.kind === "env") return; // env handled separately in Task 4
    setMatchInfo(applyCmSearch(view, searchOpen ? searchQuery : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchOpen, active]);

  const searchNext = useCallback(() => {
    const view = searchViewRef.current;
    if (!view || matchInfo.count === 0) return;
    findNext(view);
    setMatchInfo((m) => ({ ...m, index: (m.index + 1) % m.count }));
    view.focus();
  }, [matchInfo.count]);

  const searchPrev = useCallback(() => {
    const view = searchViewRef.current;
    if (!view || matchInfo.count === 0) return;
    findPrevious(view);
    setMatchInfo((m) => ({ ...m, index: (m.index - 1 + m.count) % m.count }));
    view.focus();
  }, [matchInfo.count]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQueryState("");
    const view = searchViewRef.current;
    if (view) view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (searchOpen) { closeSearch(); return; }
        attemptClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (isDirty && !saving && active) handleSave();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        // ⌘Z reaches us now that Undo/Redo were stripped from the native Edit
        // menu (see src-tauri/src/menu.rs). Compose is left to CodeMirror.
        if (active?.kind === "env") {
          e.preventDefault();
          envMode === "rows" ? handleRowsUndo() : handleRawUndo();
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        if (active?.kind === "env") {
          e.preventDefault();
          envMode === "rows" ? handleRowsRedo() : handleRawRedo();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, saving, content, rows, active, envMode, attemptClose, searchOpen, closeSearch]);

  async function handleSave() {
    if (!active) return;
    setSaving(true);
    setError(null);
    setErrorLine(undefined);
    try {
      if (active.kind === "compose") {
        const path = await saveComposeYaml(appId, content);
        setOriginalContent(content);
        try {
          const proj = await parseDockerCompose(path || active.path);
          let firstHostPort: number | null = null;
          for (const svc of proj.services) {
            for (const [host] of svc.ports) {
              firstHostPort = host;
              break;
            }
            if (firstHostPort != null) break;
          }
          if (firstHostPort != null && firstHostPort !== currentPort) {
            setRestartPrompt({ oldPort: currentPort, newPort: firstHostPort });
          } else {
            setRestartPrompt(null);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(msg);
          const m = msg.match(/line (\d+)/i);
          setErrorLine(m ? parseInt(m[1], 10) : undefined);
        }
        showToast(true, "Saved");
      } else if (active.kind === "generic") {
        await writeConfigFile(active.path, content);
        setOriginalContent(content);
        await refreshList();
        showToast(true, "Saved");
      } else {
        const text = envMode === "raw" ? rawContent : serializeRows(rows);
        await writeConfigFile(active.path, text);
        const parsed = parseEnvContent(text);
        setOriginalRows(parsed);
        if (envMode === "raw") setRows(parsed);
        await refreshList();
        showToast(true, "Saved");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(false, "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleReload() {
    if (!active) return;
    if (isDirty) {
      const ok = window.confirm("Reload will discard unsaved changes. Continue?");
      if (!ok) return;
    }
    await loadEntry(active);
    await refreshList();
  }

  async function selectFile(entry: FileEntry) {
    if (entry.path === activePath) return;
    if (isDirty) {
      const ok = window.confirm("You have unsaved changes. Switch file and discard?");
      if (!ok) return;
    }
    await loadEntry(entry);
  }

  /** Copy a template (`.env.example`) to its target (`.env`) with secrets blanked,
   *  then open the new file. Refreshing the list clears the banner, since the
   *  backend stops offering a template once its target exists. */
  async function handleCreateFromTemplate(entry: FileEntry) {
    const target = entry.templateTarget;
    if (!target || creating) return;
    if (isDirty) {
      const ok = window.confirm("You have unsaved changes. Create the file and discard them?");
      if (!ok) return;
    }
    setCreating(target);
    setError(null);
    try {
      const text = await createConfigFromTemplate(entry.path, target);
      await refreshList();
      // Seed the editor from what the command returned rather than reading the
      // file back — it's the same bytes we just wrote.
      const parsed = parseEnvContent(text);
      setActivePath(target);
      setRows(parsed);
      setOriginalRows(parsed);
      rowsHistoryRef.current = [serializeRows(parsed)];
      rowsHistoryIdxRef.current = 0;
      setRevealed({});
      setEnvMode("rows");
      setRawContent("");
      setErrorLine(undefined);
      setFileMissing(false);
      setRestartPrompt(null);
      showToast(true, `Created ${baseName(target)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Someone may have created it behind our back; resync so the banner agrees.
      await refreshList();
    } finally {
      setCreating(null);
    }
  }

  async function handleRestart() {
    if (!restartPrompt) return;
    const newPort = restartPrompt.newPort;
    setRestartPrompt(null);
    const app = apps.find((a) => a.id === appId);
    if (app && newPort !== app.port) {
      const conflict = apps.find((a) => a.id !== appId && a.port === newPort);
      if (conflict) {
        setError(
          `Port ${newPort} is already assigned to "${conflict.name}". ` +
          `Edit that app's port (or stop it first), or change this compose to publish on a different port.`,
        );
        setRestartPrompt({ oldPort: app.port, newPort });
        return;
      }
      try {
        await updateApp({
          id: appId,
          name: app.name,
          root_dir: app.root_dir,
          port: newPort,
          subdomain: app.subdomain,
          start_command: app.start_command,
          env_file: app.env_file ?? null,
          auto_start: app.auto_start ?? false,
          env_vars: app.env_vars ?? {},
          restart_policy: app.restart_policy ?? "never",
          max_retries: app.max_retries ?? 0,
          health_check_path: app.health_check_path ?? null,
          depends_on: app.depends_on ?? [],
          extra_subdomains: app.extra_subdomains ?? [],
          custom_domain: app.custom_domain ?? null,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/UNIQUE constraint failed: apps\.port/i.test(msg)) {
          setError(
            `Port ${newPort} just got taken by another app. ` +
            `Pick a different port in your compose, or free that port first.`,
          );
        } else {
          setError(`Failed to update port: ${msg}`);
        }
        setRestartPrompt({ oldPort: app.port, newPort });
        return;
      }
    }
    try {
      await restartApp(appId);
    } catch { /* ignore */ }
  }

  async function handleRelink() {
    if (!active || active.kind !== "compose") return;
    setRelinking(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Docker Compose", extensions: ["yml", "yaml"] }],
      });
      if (typeof selected !== "string") { setRelinking(false); return; }
      const app = apps.find((a) => a.id === appId);
      if (!app) { setError("App not found."); setRelinking(false); return; }
      await updateApp({
        id: appId,
        name: app.name,
        root_dir: app.root_dir,
        port: app.port,
        subdomain: app.subdomain,
        start_command: app.start_command,
        env_file: app.env_file ?? null,
        auto_start: app.auto_start ?? false,
        env_vars: app.env_vars ?? {},
        restart_policy: app.restart_policy ?? "never",
        max_retries: app.max_retries ?? 0,
        health_check_path: app.health_check_path ?? null,
        depends_on: app.depends_on ?? [],
        extra_subdomains: app.extra_subdomains ?? [],
        custom_domain: app.custom_domain ?? null,
        compose_file: selected,
      });
      const segs = selected.split("/");
      const refreshed: FileEntry[] = [
        { path: selected, name: segs[segs.length - 1] || selected, kind: "compose" },
      ];
      try {
        const configs = await listAppConfigFiles(appId);
        for (const c of configs) {
          refreshed.push({
            path: c.path,
            name: c.name,
            kind: c.kind,
            language: c.kind === "generic" ? (c.language as CodeLanguage) : undefined,
            size: c.size,
            modified_at: c.modified_at ?? null,
          });
        }
      } catch { /* ignore */ }
      setFiles(refreshed);
      await loadEntry(refreshed[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRelinking(false);
    }
  }

  // ── Env row actions ──────────────────────────────────────────────────────

  function updateRow(index: number, key: string, value: string) {
    setRows((prev) => prev.map((r, i) => {
      if (i !== index || r.kind !== "var") return r;
      return { kind: "var", key, value, raw: r.raw };
    }));
  }

  function deleteRow(index: number) {
    const next = rowsRef.current.filter((_, i) => i !== index);
    setRows(next);
    pushRowsHistory(next);
  }

  function addRow() {
    const next = [...rowsRef.current, { kind: "var" as const, key: "", value: "", raw: "" }];
    setRows(next);
    pushRowsHistory(next);
  }

  function toggleReveal(index: number) {
    setRevealed((prev) => ({ ...prev, [index]: !prev[index] }));
  }

  function toggleEnvMode() {
    if (envMode === "rows") {
      // Save history before entering raw so we can restore it on the way back
      rowsHistorySavedRef.current = [...rowsHistoryRef.current];
      rowsHistoryIdxSavedRef.current = rowsHistoryIdxRef.current;
      const text = serializeRows(rows);
      rawHistoryRef.current = [text];
      rawHistoryIdxRef.current = 0;
      setRawContent(text);
      setEnvMode("raw");
    } else {
      const parsed = parseEnvContent(rawContent);
      setRows(parsed);
      setRevealed({});
      setEnvMode("rows");
      // Restore saved history up to the point we left, then append current state
      const restored = rowsHistorySavedRef.current.slice(0, rowsHistoryIdxSavedRef.current + 1);
      const newSnap = serializeRows(parsed);
      if (restored[restored.length - 1] !== newSnap) restored.push(newSnap);
      rowsHistoryRef.current = restored;
      rowsHistoryIdxRef.current = restored.length - 1;
    }
  }

  // ── Rows undo/redo ──────────────────────────────────────────────────────

  function pushRowsHistory(nextRows: EnvRow[]) {
    const snap = serializeRows(nextRows);
    const last = rowsHistoryRef.current[rowsHistoryIdxRef.current];
    if (snap === last) return; // no-op if nothing changed
    const base = rowsHistoryRef.current.slice(0, rowsHistoryIdxRef.current + 1);
    base.push(snap);
    if (base.length > 50) base.shift();
    rowsHistoryRef.current = base;
    rowsHistoryIdxRef.current = base.length - 1;
  }

  function handleRowsUndo() {
    // updateRow doesn't snapshot on every keystroke (only on blur/add/delete),
    // so capture any in-progress typing as a snapshot first — otherwise ⌘Z
    // before a blur would have nothing to step back to.
    flushInputToHistory();
    if (rowsHistoryIdxRef.current <= 0) return;
    rowsHistoryIdxRef.current -= 1;
    const snap = rowsHistoryRef.current[rowsHistoryIdxRef.current];
    setRows(parseEnvContent(snap));
    setRevealed({});
  }

  function handleRowsRedo() {
    if (rowsHistoryIdxRef.current >= rowsHistoryRef.current.length - 1) return;
    rowsHistoryIdxRef.current += 1;
    const snap = rowsHistoryRef.current[rowsHistoryIdxRef.current];
    setRows(parseEnvContent(snap));
    setRevealed({});
  }

  function flushInputToHistory() {
    pushRowsHistory(rowsRef.current);
  }

  function handleRawChange(text: string) {
    setRawContent(text);
    if (rawDebounceRef.current) window.clearTimeout(rawDebounceRef.current);
    rawDebounceRef.current = window.setTimeout(() => {
      const last = rawHistoryRef.current[rawHistoryIdxRef.current];
      if (text === last) return;
      const base = rawHistoryRef.current.slice(0, rawHistoryIdxRef.current + 1);
      base.push(text);
      if (base.length > 50) base.shift();
      rawHistoryRef.current = base;
      rawHistoryIdxRef.current = base.length - 1;
    }, 400);
  }

  function handleRawUndo() {
    if (rawHistoryIdxRef.current <= 0) return;
    rawHistoryIdxRef.current -= 1;
    setRawContent(rawHistoryRef.current[rawHistoryIdxRef.current]);
  }

  function handleRawRedo() {
    if (rawHistoryIdxRef.current >= rawHistoryRef.current.length - 1) return;
    rawHistoryIdxRef.current += 1;
    setRawContent(rawHistoryRef.current[rawHistoryIdxRef.current]);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 bg-[#0a0a0c]/95 backdrop-blur-sm z-50 flex flex-col overflow-hidden"
      onMouseDown={(e) => { if (e.target === e.currentTarget) attemptClose(); }}
    >
      <div className="flex flex-col flex-1 m-4 md:m-8 bg-[#1c1c1e] border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.07] shrink-0 select-none">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-zinc-500">
            <rect x="2" y="2" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M4.5 5h5M4.5 7h5M4.5 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="text-[13px] font-semibold text-zinc-200">{appName}</span>
          <span className="text-zinc-700 text-[12px]">·</span>
          <span className="text-[12px] text-zinc-500">files</span>

          <div className="flex-1 flex items-center justify-end px-2">
            {searchOpen && (active?.kind === "compose" || active?.kind === "generic") && (
              <EditorSearchBar
                query={searchQuery}
                matchIndex={matchInfo.index}
                matchCount={matchInfo.count}
                onQueryChange={setSearchQueryState}
                onNext={searchNext}
                onPrev={searchPrev}
                onClose={closeSearch}
                inputRef={searchInputRef}
              />
            )}
          </div>

          {/* Empty values still to fill. Rows-mode only: in raw mode `rows` is
              stale, `rawContent` is the source of truth. */}
          {active?.kind === "env" && envMode === "rows" && emptyValueCount > 0 && (
            <span
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-amber-500/10 border border-amber-500/25 text-amber-300"
              title="Variables with an empty value"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              {emptyValueCount} {emptyValueCount === 1 ? "value needs" : "values need"} filling
            </span>
          )}

          {/* Mode toggle — env files only */}
          {active?.kind === "env" && (
            <div className="flex items-center rounded-md border border-white/[0.08] overflow-hidden text-[11px]">
              <button
                onClick={() => envMode !== "rows" && toggleEnvMode()}
                className={`px-2.5 py-1 transition-colors ${
                  envMode === "rows"
                    ? "bg-white/[0.10] text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05]"
                }`}
              >
                Rows
              </button>
              <button
                onClick={() => envMode !== "raw" && toggleEnvMode()}
                className={`px-2.5 py-1 transition-colors ${
                  envMode === "raw"
                    ? "bg-white/[0.10] text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05]"
                }`}
              >
                Raw
              </button>
            </div>
          )}

          {/* Reveal all sensitive values at once (per-row eye toggles still work).
              Shown in both modes so switching Rows/Raw doesn't shift the toolbar.
              Undo/redo is keyboard-only — ⌘Z / ⌘⇧Z, as in any editor. */}
          {active?.kind === "env" && (
            <button
              onClick={() => setShowAllSensitive((v) => !v)}
              title={showAllSensitive ? "Mask secret values again" : "Reveal masked secret values"}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border transition-colors ${
                showAllSensitive
                  ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                  : "bg-white/[0.05] text-zinc-400 border-white/[0.08] hover:text-zinc-200 hover:bg-white/[0.08]"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 11 11" fill="none">
                <path d="M1.5 5.5S3.5 2 5.5 2s4 3.5 4 3.5-2 3.5-4 3.5S1.5 5.5 1.5 5.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                <circle cx="5.5" cy="5.5" r="1.2" stroke="currentColor" strokeWidth="1.1"/>
                {showAllSensitive && <path d="M1.5 9.5l8-8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>}
              </svg>
              {showAllSensitive ? "Hide secrets" : "Reveal secrets"}
            </button>
          )}

          <button
            onClick={handleReload}
            disabled={!active || loading}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-white/[0.05] border border-white/[0.08] text-zinc-300 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Reload
          </button>

          <button
            onClick={handleSave}
            disabled={!active || !isDirty || saving}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-blue-500/15 border border-blue-500/30 text-blue-300 hover:bg-blue-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>

          <button
            onClick={attemptClose}
            className="p-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] rounded-md transition-colors"
            title="Close (Esc)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Restart prompt — compose port drift */}
        {restartPrompt && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-[12px] text-amber-200">
            <span>
              Proxy port changed: <span className="font-mono">{restartPrompt.oldPort}</span> → <span className="font-mono">{restartPrompt.newPort}</span>. Restart to apply.
            </span>
            <div className="flex-1" />
            <button onClick={handleRestart} className="px-2.5 py-1 text-[11px] font-medium bg-amber-600/80 hover:bg-amber-500 text-white rounded-md transition-colors">
              Restart now
            </button>
            <button onClick={() => setRestartPrompt(null)} className="text-[11px] text-amber-300 hover:text-amber-100 transition-colors">
              Later
            </button>
          </div>
        )}

        {/* Template prompt — a template exists but its target doesn't */}
        {templateCandidates.map((f) => (
          <div
            key={f.path}
            className="flex items-center gap-3 px-4 py-2.5 bg-blue-500/[0.07] border-b border-blue-500/20 text-[12px] text-blue-100"
          >
            <span>
              No <span className="font-mono">{baseName(f.templateTarget!)}</span> yet — create it from{" "}
              <span className="font-mono">{f.name}</span>. Secret values are left blank for you to fill in.
            </span>
            <div className="flex-1" />
            <button
              onClick={() => handleCreateFromTemplate(f)}
              disabled={creating !== null}
              className="px-2.5 py-1 text-[11px] font-medium bg-blue-600/80 hover:bg-blue-500 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating === f.templateTarget ? "Creating…" : `Create ${baseName(f.templateTarget!)}`}
            </button>
          </div>
        ))}

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <div className="w-64 shrink-0 border-r border-white/[0.07] overflow-y-auto bg-[#161618]">
            {files.length === 0 ? (
              <div className="px-4 py-6 text-[12px] text-zinc-500">No editable files for this app.</div>
            ) : (
              <ul className="py-1">
                {files.map((f) => {
                  const isActive = f.path === activePath;
                  const dirty = isActive && isDirty;
                  return (
                    <li key={f.path}>
                      <button
                        onClick={() => selectFile(f)}
                        className={`w-full text-left px-3 py-2 transition-colors ${
                          isActive
                            ? "bg-blue-500/10 border-l-2 border-blue-400"
                            : "border-l-2 border-transparent hover:bg-white/[0.04]"
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          {dirty && (
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
                          )}
                          <span className={`text-[12px] font-mono truncate ${isActive ? "text-zinc-100" : "text-zinc-300"}`}>
                            {f.name}
                          </span>
                          <span className={`ml-auto text-[9px] uppercase tracking-wide px-1 py-0.5 rounded shrink-0 ${
                            f.kind === "compose"
                              ? "bg-teal-500/10 border border-teal-500/20 text-teal-300"
                              : f.kind === "generic"
                                ? "bg-indigo-500/10 border border-indigo-500/20 text-indigo-300"
                                : "bg-zinc-700/30 border border-zinc-600/30 text-zinc-400"
                          }`}>
                            {f.kind === "generic" ? (f.language ?? "file") : f.kind}
                          </span>
                        </div>
                        {f.size != null && (
                          <div className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-1.5">
                            <span>{formatSize(f.size)}</span>
                            <span className="text-zinc-700">·</span>
                            <span>{formatAgo(f.modified_at)}</span>
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Editor pane */}
          <div className="flex-1 min-w-0 flex flex-col bg-[#0d0d0f]">
            {error && (
              <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-[11px] text-red-300 font-mono whitespace-pre-wrap break-words">
                {error}
              </div>
            )}

            {!active ? (
              <div className="flex-1 flex items-center justify-center text-[12px] text-zinc-600">
                Select a file to edit
              </div>
            ) : loading ? (
              <div className="flex-1 flex items-center justify-center text-[12px] text-zinc-500">
                Loading…
              </div>
            ) : fileMissing ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <div className="max-w-md flex flex-col gap-3 items-start">
                  <div className="flex items-center gap-2 text-amber-300 text-[13px]">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M7 1.5l6 11H1l6-11z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                      <path d="M7 6v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                      <circle cx="7" cy="10.5" r="0.6" fill="currentColor"/>
                    </svg>
                    Compose file not found
                  </div>
                  <code className="text-[11px] font-mono text-zinc-500 bg-white/[0.03] border border-white/[0.05] rounded px-2 py-1 break-all">
                    {active.path}
                  </code>
                  <div className="text-[12px] text-zinc-400 leading-relaxed">
                    Folder might've moved or been renamed. Browse for the new location to re-link.
                  </div>
                  <button onClick={handleRelink} disabled={relinking} className="mt-1 px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors disabled:opacity-50">
                    {relinking ? "Linking…" : "Browse for compose file…"}
                  </button>
                </div>
              </div>
            ) : active.kind === "compose" ? (
              <div className="flex-1 min-h-0 overflow-auto p-4">
                <YamlEditor
                  value={content}
                  onChange={setContent}
                  rows={28}
                  maxHeight="100%"
                  errorLine={errorLine}
                  errorMessage={error ?? undefined}
                  onReady={(view) => { searchViewRef.current = view; }}
                />
              </div>
            ) : active.kind === "generic" ? (
              <div className="flex-1 min-h-0 overflow-auto p-4">
                <CodeEditor
                  value={content}
                  onChange={setContent}
                  language={active.language ?? "text"}
                  rows={28}
                  maxHeight="100%"
                  onReady={(view) => { searchViewRef.current = view; }}
                />
              </div>
            ) : envMode === "raw" ? (
              /* ── Env raw textarea ── secrets masked (read-only) until revealed,
                 so the raw view is as private as the rows view. */
              showAllSensitive ? (
                <textarea
                  value={rawContent}
                  onChange={(e) => handleRawChange(e.target.value)}
                  spellCheck={false}
                  className="flex-1 min-h-0 w-full bg-transparent text-[12px] font-mono text-zinc-200 p-4 resize-none focus:outline-none leading-relaxed"
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                />
              ) : (
                <div className="flex-1 min-h-0 flex flex-col">
                  <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] text-zinc-500 border-b border-white/[0.05] bg-white/[0.02]">
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-amber-400/70">
                      <path d="M1.5 5.5S3.5 2 5.5 2s4 3.5 4 3.5-2 3.5-4 3.5S1.5 5.5 1.5 5.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                      <circle cx="5.5" cy="5.5" r="1.2" stroke="currentColor" strokeWidth="1.1"/>
                      <path d="M1.5 9.5l8-8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                    </svg>
                    Secrets hidden — click “Reveal secrets” to edit the raw file.
                  </div>
                  <textarea
                    readOnly
                    value={maskRawSecrets(rawContent)}
                    spellCheck={false}
                    className="flex-1 min-h-0 w-full bg-transparent text-[12px] font-mono text-zinc-400 p-4 resize-none focus:outline-none leading-relaxed cursor-default"
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                  />
                </div>
              )
            ) : (
              /* ── Env per-line row editor ── */
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.05]">
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-zinc-600 uppercase tracking-wider w-[42%]">Key</th>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-zinc-600 uppercase tracking-wider">Value</th>
                      <th className="w-16" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      if (row.kind === "comment") {
                        // Blank lines become a small gap, not a bordered row, so
                        // stacked blanks don't pile up faint divider lines.
                        const blank = row.raw.trim() === "";
                        return (
                          <tr key={i}>
                            <td
                              colSpan={3}
                              className={`border-l-2 border-transparent ${blank ? "h-2.5" : "px-3 pt-2.5 pb-0.5"}`}
                            >
                              {!blank && (
                                <span className="text-[11px] font-mono text-zinc-600 select-none">
                                  {row.raw}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      }
                      const sensitive = isSensitiveKey(row.key);
                      const isRevealed = showAllSensitive || !!revealed[i];
                      const masked = sensitive && !isRevealed;
                      const unfilled = needsValue(row);
                      return (
                        <tr key={i} className="group/row hover:bg-white/[0.02]">
                          <td
                            className={`px-2 py-1 border-l-2 ${unfilled ? "border-amber-400/60" : "border-transparent"}`}
                            title={unfilled ? "This value is empty" : undefined}
                          >
                            <input
                              type="text"
                              value={row.key}
                              onChange={(e) => updateRow(i, e.target.value, row.value)}
                              onBlur={flushInputToHistory}
                              placeholder="KEY"
                              spellCheck={false}
                              className="w-full bg-transparent text-[12px] font-mono text-zinc-200 placeholder-zinc-700 focus:outline-none px-1 py-0.5 rounded hover:bg-white/[0.03] focus:bg-white/[0.05] transition-colors"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type={masked ? "password" : "text"}
                              value={row.value}
                              onChange={(e) => updateRow(i, row.key, e.target.value)}
                              onBlur={flushInputToHistory}
                              placeholder="value"
                              spellCheck={false}
                              className="w-full bg-transparent text-[12px] font-mono text-zinc-300 placeholder-zinc-700 focus:outline-none px-1 py-0.5 rounded hover:bg-white/[0.03] focus:bg-white/[0.05] transition-colors"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <div className="flex items-center gap-1 justify-end opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
                              {sensitive && (
                                <button
                                  type="button"
                                  onClick={() => toggleReveal(i)}
                                  className="p-1 text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] rounded transition-colors"
                                  title={isRevealed ? "Mask value" : "Reveal value"}
                                >
                                  {isRevealed ? (
                                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                                      <path d="M1.5 5.5S3.5 2 5.5 2s4 3.5 4 3.5-2 3.5-4 3.5S1.5 5.5 1.5 5.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                                      <circle cx="5.5" cy="5.5" r="1.2" stroke="currentColor" strokeWidth="1.1"/>
                                      <path d="M1.5 9.5l8-8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                                    </svg>
                                  ) : (
                                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                                      <path d="M1.5 5.5S3.5 2 5.5 2s4 3.5 4 3.5-2 3.5-4 3.5S1.5 5.5 1.5 5.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                                      <circle cx="5.5" cy="5.5" r="1.2" stroke="currentColor" strokeWidth="1.1"/>
                                    </svg>
                                  )}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => deleteRow(i)}
                                className="p-1 text-zinc-700 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                                title="Delete row"
                              >
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                  <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div className="px-3 py-2">
                  <button
                    type="button"
                    onClick={addRow}
                    className="flex items-center gap-1.5 text-[11px] text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.04] px-2 py-1 rounded-md transition-colors"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M5 1.5v7M1.5 5h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    </svg>
                    Add variable
                  </button>
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="px-4 py-2 border-t border-white/[0.06] text-[10px] text-zinc-600 flex items-center gap-3 shrink-0">
              <span>
                {isDirty ? "Unsaved changes" : fileMissing ? "Missing" : "Saved"}
              </span>
              <div className="flex-1" />
              <span className="font-mono truncate max-w-[60%]">{activePath ?? ""}</span>
            </div>
          </div>
        </div>
      </div>

      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] shadow-lg ${
          toast.ok ? "bg-zinc-800 border-emerald-500/30 text-emerald-400" : "bg-zinc-800 border-red-500/30 text-red-400"
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
