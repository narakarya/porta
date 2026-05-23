import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { App, Workspace } from "../../types";
import { checkKamal, kamalRun, kamalCancel, installKamal, isTauri, parseKamalAccessories, addDeployCustomCmd, updateDeployCustomCmd, deleteDeployCustomCmd } from "../../lib/commands";
import { usePortaStore } from "../../store";
import { detectLevel, LEVEL_CLS, LEVEL_BADGE, FILTER_PILLS, highlightLine } from "../../lib/log-utils";
import { useLogScroll } from "../../hooks/useLogScroll";
import { useLogFilter } from "../../hooks/useLogFilter";
import KamalConsolePane from "./KamalConsolePane";
import DeployCommandSidebar, { type CustomForm } from "./DeployCommandSidebar";

// ── Kamal cache ───────────────────────────────────────────────────────────────
let _kamalCache: { installed: boolean; version: string | null; ts: number } | null = null;
const KAMAL_CACHE_TTL = 30_000;

// ── Command definitions ───────────────────────────────────────────────────────
type CommandDef = {
  id: string;
  label: string;
  args: string[];
  group: "Deploy" | "App" | "Console" | "Server" | "Debug" | "Accessories" | "Custom";
  confirm?: boolean;
  safe?: boolean;
  // interactive = opens a full terminal pane instead of the log viewer
  interactive?: boolean;
};

const FIXED_COMMANDS: CommandDef[] = [
  { id: "deploy",        label: "Deploy",        args: ["deploy"],                               group: "Deploy",  confirm: true },
  { id: "rollback",      label: "Rollback",       args: ["rollback"],                             group: "Deploy",  confirm: true },
  { id: "lock-release",  label: "Release Lock",   args: ["lock", "release"],                      group: "Deploy",  confirm: true },
  { id: "app-logs",      label: "App Logs",       args: ["app", "logs", "-f"],                    group: "App",     safe: true },
  { id: "app-details",   label: "Details",        args: ["app", "details"],                       group: "App",     safe: true },
  { id: "app-start",     label: "Start",          args: ["app", "start"],                         group: "App" },
  { id: "app-stop",      label: "Stop",           args: ["app", "stop"],                          group: "App" },
  { id: "app-restart",   label: "Restart",        args: ["app", "restart"],                       group: "App",     confirm: true },
  { id: "exec-bash",     label: "Bash Shell",     args: ["app", "exec", "--reuse", "-i", "bash"], group: "Console", interactive: true },
  { id: "server-reboot", label: "Server Reboot",  args: ["server", "reboot"],                     group: "Server",  confirm: true },
  { id: "server-exec",   label: "Server Info",    args: ["server", "exec", "hostname && uname -a"], group: "Server", safe: true },
  { id: "audit",         label: "Audit",          args: ["audit"],                                group: "Debug",   safe: true },
  { id: "version",       label: "Version",        args: ["version"],                              group: "Debug",   safe: true },
];

// Mirrors the Rust kamal_work_dir() logic
function kamalWorkDir(configPath: string): string {
  if (configPath.endsWith("/config/deploy.yml")) {
    return configPath.split("/").slice(0, -2).join("/") || "/";
  }
  return configPath.split("/").slice(0, -1).join("/") || "/";
}

type CmdState = {
  logs: string[];
  running: boolean;
  exitCode: number | null;
  startedAt: number | null;
  runId: string | null;
};

const emptyCmdState = (): CmdState => ({ logs: [], running: false, exitCode: null, startedAt: null, runId: null });

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props { app: App; workspace: Workspace | null; onClose: () => void; }

export default function DeployModal({ app, workspace, onClose }: Props) {
  const configPath = app.deploy_config_path ?? "";

  // ── Kamal installation ────────────────────────────────────────────────────
  const [kamalStatus, setKamalStatus] = useState<{ checking: boolean; installed: boolean; version: string | null }>
    ({ checking: true, installed: false, version: null });

  // ── Sidebar search ────────────────────────────────────────────────────────
  const [cmdSearch, setCmdSearch] = useState("");

  // ── Accessories ───────────────────────────────────────────────────────────
  const [accessories, setAccessories] = useState<string[]>([]);

  useEffect(() => {
    if (!configPath) return;
    parseKamalAccessories(configPath).then(setAccessories).catch(() => {});
  }, [configPath]);

  const accessoryCommands: CommandDef[] = accessories.flatMap((name) => [
    {
      id: `acc-bash-${name}`,
      label: `${name}: bash`,
      args: ["accessory", "exec", name, "bash"],
      group: "Accessories" as const,
      interactive: true,
    },
    {
      id: `acc-logs-${name}`,
      label: `${name}: logs`,
      args: ["accessory", "logs", name, "-f"],
      group: "Accessories" as const,
      safe: true,
    },
  ]);

  const customCommands: CommandDef[] = (app.deploy_custom_commands ?? []).map((c) => ({
    id: `custom-${c.id}`,
    label: c.label,
    args: c.args,
    group: "Custom" as const,
    interactive: c.interactive,
  }));

  const allCommands = [...FIXED_COMMANDS, ...accessoryCommands, ...customCommands];

  // ── Custom command form ────────────────────────────────────────────────────
  const emptyForm = (): CustomForm => ({ id: "", label: "", rawArgs: "", interactive: false });
  const [customForm, setCustomForm] = useState<CustomForm | null>(null);
  const [customFormError, setCustomFormError] = useState("");

  // ── Per-command isolated state (Zustand) ─────────────────────────────────
  const { deploySessions, updateDeployCmdState, appendDeployLog, setDeploySelectedCmd } = usePortaStore();
  const session = deploySessions[app.id] ?? { cmdStates: {}, selectedCmdId: FIXED_COMMANDS[0].id };
  const cmdStates = session.cmdStates as Record<string, CmdState>;
  const selectedCmdId = session.selectedCmdId || (allCommands[0]?.id ?? "deploy");
  const setSelectedCmdId = (id: string) => setDeploySelectedCmd(app.id, id);
  const [pendingCmdId, setPendingCmdId] = useState<string | null>(null);
  // consoleKey: unique key per console session (forces KamalConsolePane remount on re-run)
  const [consoleKey, setConsoleKey] = useState<number>(0);

  // ── Log panel state (resets when switching commands) ──────────────────────
  const [followTail, setFollowTail]   = useState(true);
  const [copiedLine, setCopiedLine]   = useState<number | null>(null);
  const [copiedToast, setCopiedToast] = useState(false);

  const logBodyRef   = useRef<HTMLDivElement>(null);
  const searchRef    = useRef<HTMLInputElement>(null);
  const toastTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Hooks ─────────────────────────────────────────────────────────────────
  const selectedLogs = cmdStates[selectedCmdId]?.logs ?? [];

  const {
    search: logQuery, setSearch: setLogQuery,
    levelFilter, setLevelFilter,
    filteredLogs: filteredLines,
    reset: resetLogFilter,
  } = useLogFilter(selectedLogs);

  const { logEndRef, scrollToBottom, resetFirstScroll } =
    useLogScroll({ logs: selectedLogs, followTail });

  // Reset log panel and console key when switching selected command
  useEffect(() => {
    resetLogFilter();
    setFollowTail(true);
    setConsoleKey(0);
    resetFirstScroll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCmdId]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (logQuery) { setLogQuery(""); return; }
        if (pendingCmdId) { setPendingCmdId(null); return; }
        onClose();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, logQuery, pendingCmdId]);


  function handleLogScroll() {
    const el = logBodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && followTail) setFollowTail(false);
    if (atBottom && !followTail) setFollowTail(true);
  }

  // ── Kamal check ───────────────────────────────────────────────────────────
  async function doCheckKamal() {
    if (_kamalCache && Date.now() - _kamalCache.ts < KAMAL_CACHE_TTL) {
      setKamalStatus({ checking: false, installed: _kamalCache.installed, version: _kamalCache.version });
      return;
    }
    setKamalStatus({ checking: true, installed: false, version: null });
    try {
      const r = await checkKamal();
      _kamalCache = { installed: r.installed, version: r.version, ts: Date.now() };
      setKamalStatus({ checking: false, installed: r.installed, version: r.version });
    } catch { setKamalStatus({ checking: false, installed: false, version: null }); }
  }
  useEffect(() => { doCheckKamal(); }, []);

  // Re-attach Tauri event listeners for commands still running when modal was last closed
  useEffect(() => {
    if (!isTauri) return;
    const currentSession = deploySessions[app.id];
    if (!currentSession) return;
    const cleanups: Array<() => void> = [];

    for (const [cmdId, state] of Object.entries(currentSession.cmdStates)) {
      if (!state.running || !state.runId) continue;
      const runId = state.runId;
      Promise.all([
        listen<string>(`kamal:log:${runId}`, (e) => {
          const raw = e.payload.startsWith("[err]") ? e.payload.slice(5).trimStart() : e.payload;
          appendDeployLog(app.id, cmdId, raw);
        }),
        listen<number>(`kamal:exit:${runId}`, (e) => {
          updateDeployCmdState(app.id, cmdId, { running: false, exitCode: e.payload });
        }),
      ]).then(([ul, ux]) => { cleanups.push(ul, ux); });
    }

    return () => cleanups.forEach(fn => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id]);

  // ── Run a command (per-run isolated channel) ──────────────────────────────
  async function execCommand(cmd: CommandDef) {
    setPendingCmdId(null);
    setSelectedCmdId(cmd.id);

    if (cmd.interactive) {
      setConsoleKey(k => k + 1);
      return;
    }
    const runId = `run-${cmd.id}-${Date.now()}`;
    updateDeployCmdState(app.id, cmd.id, {
      logs: [], running: true, exitCode: null, startedAt: Date.now(), runId,
    });

    if (isTauri) {
      let unlistenLog: (() => void) | undefined;
      let unlistenExit: (() => void) | undefined;

      [unlistenLog, unlistenExit] = await Promise.all([
        listen<string>(`kamal:log:${runId}`, (e) => {
          const raw = e.payload.startsWith("[err]") ? e.payload.slice(5).trimStart() : e.payload;
          appendDeployLog(app.id, cmd.id, raw);
        }),
        listen<number>(`kamal:exit:${runId}`, (e) => {
          updateDeployCmdState(app.id, cmd.id, { running: false, exitCode: e.payload });
          unlistenLog?.();
          unlistenExit?.();
          if (e.payload === 0) doCheckKamal();
        }),
      ]);

      try {
        await kamalRun(app.id, configPath, cmd.args, runId);
      } catch (e) {
        unlistenLog?.(); unlistenExit?.();
        updateDeployCmdState(app.id, cmd.id, {
          running: false,
          exitCode: -1,
        });
      }
    }
  }

  // ── Handle sidebar action ─────────────────────────────────────────────────
  function handleSidebarRun(cmd: CommandDef) {
    if (!kamalStatus.installed || kamalStatus.checking) return;
    if (cmd.confirm) {
      // Toggle confirmation state
      setPendingCmdId(prev => prev === cmd.id ? null : cmd.id);
      setSelectedCmdId(cmd.id);
    } else {
      execCommand(cmd);
    }
  }

  const [stoppingCmdId, setStoppingCmdId] = useState<string | null>(null);
  function handleStop(cmdId: string) {
    const runId = cmdStates[cmdId]?.runId;
    if (!runId) return;
    setStoppingCmdId(cmdId);
    kamalCancel(runId).catch(() => {});
    // Reset the "Stopping…" label after the 2s grace + SIGKILL window.
    setTimeout(() => setStoppingCmdId(prev => prev === cmdId ? null : prev), 2500);
  }

  function handleConfirm() {
    const cmd = allCommands.find(c => c.id === pendingCmdId);
    if (cmd) execCommand(cmd);
  }

  // ── Install kamal ─────────────────────────────────────────────────────────
  async function handleInstallKamal() {
    const runId = `run-__install__-${Date.now()}`;
    updateDeployCmdState(app.id, "__install__", { logs: [], running: true, exitCode: null, startedAt: Date.now(), runId });
    setSelectedCmdId("__install__" as string);
    if (isTauri) {
      let unlistenLog: (() => void) | undefined;
      let unlistenExit: (() => void) | undefined;
      [unlistenLog, unlistenExit] = await Promise.all([
        listen<string>(`kamal:log:${runId}`, (e) => {
          const raw = e.payload.startsWith("[err]") ? e.payload.slice(5).trimStart() : e.payload;
          appendDeployLog(app.id, "__install__", raw);
        }),
        listen<number>(`kamal:exit:${runId}`, (e) => {
          updateDeployCmdState(app.id, "__install__", { running: false, exitCode: e.payload });
          unlistenLog?.(); unlistenExit?.();
          if (e.payload === 0) doCheckKamal();
        }),
      ]);
      try { await installKamal(app.id, runId); }
      catch (e) {
        unlistenLog?.(); unlistenExit?.();
        updateDeployCmdState(app.id, "__install__", { logs: [`Error: ${String(e)}`], running: false, exitCode: 1 });
      }
    } else {
      const lines = ["Fetching gem metadata…", "Installing kamal…", "Successfully installed kamal-2.10.0"];
      let i = 0;
      function next() {
        if (i >= lines.length) {
          _kamalCache = { installed: true, version: "2.10.0 (mock)", ts: Date.now() };
          setKamalStatus({ checking: false, installed: true, version: "2.10.0 (mock)" });
          updateDeployCmdState(app.id, "__install__", { running: false, exitCode: 0 });
          return;
        }
        appendDeployLog(app.id, "__install__", lines[i++]);
        setTimeout(next, 400);
      }
      setTimeout(next, 200);
    }
  }

  // ── Copy helpers ──────────────────────────────────────────────────────────
  function showCopiedToast() {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setCopiedToast(true);
    toastTimer.current = setTimeout(() => setCopiedToast(false), 1500);
  }
  function copyLine(line: string, idx: number) {
    navigator.clipboard.writeText(line).then(() => {
      setCopiedLine(idx); showCopiedToast();
      setTimeout(() => setCopiedLine(null), 1200);
    });
  }
  function handleMouseUp() {
    const sel = window.getSelection();
    if (sel?.toString().length) navigator.clipboard.writeText(sel.toString()).then(() => showCopiedToast()).catch(() => {});
  }


  // ── Sidebar filtered commands ─────────────────────────────────────────────
  const sidebarCmds = useMemo(() => {
    const q = cmdSearch.toLowerCase();
    return q ? allCommands.filter(c => c.label.toLowerCase().includes(q)) : allCommands;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmdSearch, allCommands.length, accessories.length, app.deploy_custom_commands?.length]);

  const groups = useMemo(() => {
    const map = new Map<string, CommandDef[]>();
    for (const cmd of sidebarCmds) {
      if (!map.has(cmd.group)) map.set(cmd.group, []);
      map.get(cmd.group)!.push(cmd);
    }
    return map;
  }, [sidebarCmds]);

  // ── Selected command meta ─────────────────────────────────────────────────
  const selectedCmd  = allCommands.find(c => c.id === selectedCmdId) ?? allCommands[0];
  const isInteractive = selectedCmd.interactive ?? false;
  const consoleTermId = `kamal-console-${app.id}-${selectedCmdId}`;
  const selectedState = cmdStates[selectedCmdId] ?? emptyCmdState();
  const isSelectedRunning = selectedState.running;

  // ── Custom command handlers ───────────────────────────────────────────────
  async function handleSaveCustomCmd() {
    if (!customForm) return;
    const label = customForm.label.trim();
    const rawArgs = customForm.rawArgs.trim();
    if (!label) { setCustomFormError("Label is required"); return; }
    if (!rawArgs) { setCustomFormError("Args are required"); return; }
    const args = rawArgs.split(/\s+/);
    const isEdit = !!customForm.id;
    const id = isEdit ? customForm.id : crypto.randomUUID();
    const customCmd = { id, label, args, interactive: customForm.interactive };
    try {
      if (isEdit) {
        await updateDeployCustomCmd(app.id, customCmd);
      } else {
        await addDeployCustomCmd(app.id, customCmd);
      }
      usePortaStore.getState().load();
      setCustomForm(null);
      setCustomFormError("");
    } catch (e) {
      setCustomFormError(String(e));
    }
  }

  async function handleDeleteCustomCmd(rawCmdId: string) {
    try {
      await deleteDeployCustomCmd(app.id, rawCmdId);
      usePortaStore.getState().load();
    } catch {}
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-[#111113] flex flex-col">

      {/* Copied toast */}
      <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 border border-white/10 text-[11px] text-emerald-400 shadow-lg transition-all duration-200 pointer-events-none ${copiedToast ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"}`}>
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Copied
      </div>

      {/* ── Global header ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.08] shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[14px] font-semibold text-zinc-100 truncate">{app.name}</span>
          {workspace && <>
            <span className="text-zinc-700 text-[12px]">·</span>
            <span className="text-[12px] text-zinc-500 truncate">{workspace.name}</span>
          </>}
        </div>

        {kamalStatus.checking ? (
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-500 bg-zinc-800/60 border border-white/[0.07] px-2.5 py-1 rounded-full shrink-0">
            <span className="w-3 h-3 border border-zinc-500 border-t-transparent rounded-full animate-spin" />
            checking…
          </span>
        ) : kamalStatus.installed ? (
          <span className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full font-mono shrink-0">
            kamal {kamalStatus.version ?? "detected"}
          </span>
        ) : (
          <span className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 px-2.5 py-1 rounded-full shrink-0">
            kamal not found
          </span>
        )}

        <span className="text-[11px] text-zinc-400 bg-white/[0.05] border border-white/[0.07] px-2.5 py-1 rounded-full font-mono shrink-0">
          production
        </span>

        <button onClick={onClose} className="shrink-0 p-1.5 rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-white/[0.07] transition-colors" title="Close (Esc)">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M2 2l9 9M11 2L2 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* ── Body: sidebar + log panel ──────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* ── Sidebar ───────────────────────────────────────────────────────── */}
        <DeployCommandSidebar
          app={app}
          configPath={configPath}
          groups={groups}
          cmdStates={cmdStates}
          selectedCmdId={selectedCmdId}
          pendingCmdId={pendingCmdId}
          cmdSearch={cmdSearch}
          kamalInstalled={kamalStatus.installed}
          kamalChecking={kamalStatus.checking}
          customForm={customForm}
          customFormError={customFormError}
          onCmdSearchChange={setCmdSearch}
          onSelectCmd={setSelectedCmdId}
          onRunCmd={handleSidebarRun}
          onEditCustomCmd={setCustomForm}
          onDeleteCustomCmd={handleDeleteCustomCmd}
          onSaveCustomCmd={handleSaveCustomCmd}
          onCancelCustomForm={() => { setCustomForm(null); setCustomFormError(""); }}
          onCustomFormChange={setCustomForm}
          onAddCustomCmd={() => setCustomForm(emptyForm())}
          onInstallKamal={handleInstallKamal}
        />

        {/* ── Log panel ─────────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Panel header: command name + run button */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.06] shrink-0">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              {isSelectedRunning && (
                <span className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
              )}
              <span className="text-[13px] font-medium text-zinc-200 truncate">
                kamal {selectedCmd.args.join(" ")}
              </span>
              {selectedState.exitCode !== null && !isSelectedRunning && (
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded font-mono shrink-0 ${
                  selectedState.exitCode === 0
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                    : "bg-red-500/15 text-red-400 border border-red-500/20"
                }`}>
                  exit {selectedState.exitCode}
                </span>
              )}
            </div>

            {/* Search + filters — log commands only */}
            {!isInteractive && <>
              <div className="relative w-48 shrink-0">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none">
                  <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3"/>
                  <path d="M8 8l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
                <input spellCheck={false}
                  ref={searchRef}
                  value={logQuery}
                  onChange={e => setLogQuery(e.target.value)}
                  placeholder="Search… (⌘F)"
                  className="w-full bg-white/[0.05] border border-white/[0.07] rounded-lg pl-6 pr-2 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/50 transition-all"
                />
                {logQuery && (
                  <button onClick={() => setLogQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300">
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                      <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                    </svg>
                  </button>
                )}
              </div>
              {logQuery && (
                <span className="text-[11px] text-zinc-500 shrink-0">
                  {filteredLines.length === 0 ? "no matches" : `${filteredLines.length} match${filteredLines.length === 1 ? "" : "es"}`}
                </span>
              )}
              <div className="flex items-center gap-1 shrink-0">
                {FILTER_PILLS.map(({ key, label, activeCls }) => (
                  <button
                    key={key}
                    onClick={() => setLevelFilter(levelFilter === key ? "all" : key)}
                    className={`px-1.5 py-1 rounded text-[10px] font-medium border transition-colors ${
                      levelFilter === key ? activeCls : "bg-white/[0.03] text-zinc-600 border-white/[0.05] hover:text-zinc-400"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                {levelFilter !== "all" && (
                  <button onClick={() => setLevelFilter("all")} className="px-1 py-1 rounded text-[10px] text-zinc-600 border border-white/[0.05] hover:text-zinc-300 transition-colors">×</button>
                )}
              </div>
              <button
                onClick={() => { setFollowTail(v => !v); if (!followTail) scrollToBottom(); }}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors shrink-0 ${
                  followTail ? "bg-blue-500/15 text-blue-400 border-blue-500/25" : "bg-white/[0.03] text-zinc-500 border-white/[0.05] hover:text-zinc-300"
                }`}
              >
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                  <path d="M5 1v6M2.5 4.5L5 7l2.5-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 9h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
                {followTail ? "Following" : "Follow"}
              </button>
            </>}

            {/* Run / Stop / New Session button */}
            {isSelectedRunning && !isInteractive ? (
              <button
                onClick={() => handleStop(selectedCmdId)}
                disabled={stoppingCmdId === selectedCmdId}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors shrink-0 bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-60 disabled:cursor-not-allowed"
                title="Stop (SIGINT → SIGKILL after 2s)"
              >
                {stoppingCmdId === selectedCmdId ? (
                  <span className="w-2.5 h-2.5 border border-red-400/60 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                    <rect x="2" y="2" width="6" height="6" rx="0.5"/>
                  </svg>
                )}
                {stoppingCmdId === selectedCmdId ? "Stopping…" : "Stop"}
              </button>
            ) : (
              <button
                onClick={() => handleSidebarRun(selectedCmd)}
                disabled={!kamalStatus.installed || kamalStatus.checking}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors shrink-0 disabled:opacity-40 ${
                  pendingCmdId === selectedCmdId
                    ? "bg-amber-500/25 text-amber-300 ring-1 ring-amber-500/40"
                    : isInteractive
                    ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
                    : "bg-blue-500/15 text-blue-400 hover:bg-blue-500/25"
                }`}
              >
                {isInteractive ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <rect x="1" y="1" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                    <path d="M3 4l1.5 1.5L3 7M5.5 7H7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2.5 1.5l6 3.5-6 3.5V1.5z" fill="currentColor"/>
                  </svg>
                )}
                {pendingCmdId === selectedCmdId ? "Confirm?" : isInteractive ? (consoleKey > 0 ? "New Session" : "Open Console") : "Run"}
              </button>
            )}

            {/* Clear */}
            <button
              onClick={() => updateDeployCmdState(app.id, selectedCmdId, { logs: [], exitCode: null })}
              className="px-2 py-1.5 rounded-md text-[11px] text-zinc-600 hover:text-zinc-300 bg-white/[0.03] border border-white/[0.05] hover:bg-white/[0.07] transition-colors shrink-0"
            >
              Clear
            </button>
          </div>

          {/* Confirmation bar */}
          {pendingCmdId === selectedCmdId && (
            <div className="flex items-center gap-3 px-4 py-2 bg-amber-500/[0.07] border-b border-amber-500/20 shrink-0">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className="text-amber-400 shrink-0">
                <path d="M7 1L13 12H1L7 1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                <path d="M7 5.5V8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                <circle cx="7" cy="10" r="0.6" fill="currentColor"/>
              </svg>
              <span className="flex-1 text-[12px] text-amber-300">
                Run <code className="font-mono text-amber-200">kamal {selectedCmd.args.join(" ")}</code> on production?
              </span>
              <button onClick={() => setPendingCmdId(null)} className="px-2.5 py-1 rounded-md text-[12px] text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.07] transition-colors">
                Cancel
              </button>
              <button onClick={handleConfirm} className="px-3 py-1 rounded-md text-[12px] font-medium bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors">
                Confirm
              </button>
            </div>
          )}

          {/* Terminal pane — shown for interactive commands once Run is clicked */}
          {isInteractive && consoleKey > 0 && (
            <KamalConsolePane
              key={`${consoleTermId}-${consoleKey}`}
              termId={`${consoleTermId}-${consoleKey}`}
              workDir={kamalWorkDir(configPath)}
              initialCmd={`kamal ${selectedCmd.args.join(" ")}`}
            />
          )}
          {isInteractive && consoleKey === 0 && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[12px] text-zinc-600">Press Run to open an interactive shell.</p>
            </div>
          )}

          {/* Log body — shown for non-interactive commands */}
          {!isInteractive && <div
            ref={logBodyRef}
            onScroll={handleLogScroll}
            onMouseUp={handleMouseUp}
            className="flex-1 overflow-y-auto px-4 py-3 font-mono select-text"
          >
            {selectedState.startedAt === null ? (
              <div className="flex flex-col items-center justify-center h-full text-center gap-2">
                <p className="text-[12px] text-zinc-600">
                  {kamalStatus.checking ? "Checking kamal…" : !kamalStatus.installed ? "Install kamal to get started." : "Select a command and press Run."}
                </p>
              </div>
            ) : filteredLines.length === 0 ? (
              <p className="text-[12px] text-zinc-600 mt-8 text-center select-none">
                {logQuery || levelFilter !== "all" ? "No lines match your filter." : isSelectedRunning ? "Waiting for output…" : "No output."}
              </p>
            ) : (
              <div className="flex flex-col">
                {filteredLines.map(({ line, originalIndex }) => {
                  const level = detectLevel(line);
                  const textCls = level ? LEVEL_CLS[level] : "text-zinc-300";
                  const badge = level ? LEVEL_BADGE[level] : null;
                  return (
                    <div key={originalIndex} className="flex gap-2 py-[1px] hover:bg-white/[0.02] rounded px-1 group items-start">
                      {/* Line number */}
                      <span className="text-[10px] text-zinc-700 w-8 shrink-0 text-right tabular-nums pt-[2px] group-hover:text-zinc-500 select-none">{originalIndex + 1}</span>
                      {/* Badge */}
                      <span className="w-8 shrink-0 pt-[1px] select-none">
                        {badge && <span className={`text-[9px] font-medium px-1 py-px rounded border ${badge.cls}`}>{badge.label}</span>}
                      </span>
                      {/* Text */}
                      <span className={`flex-1 text-[11px] leading-5 whitespace-pre-wrap break-all ${textCls}`}>
                        {highlightLine(line, logQuery)}
                      </span>
                      {/* Copy */}
                      <button
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => copyLine(line, originalIndex)}
                        className={`shrink-0 pt-[2px] transition-opacity select-none ${copiedLine === originalIndex ? "opacity-100" : "opacity-0 group-hover:opacity-60"}`}
                      >
                        {copiedLine === originalIndex
                          ? <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-emerald-400"><path d="M2 5.5l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          : <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="text-zinc-600"><rect x="1" y="3" width="6" height="7" rx="1" stroke="currentColor" strokeWidth="1.1"/><path d="M3.5 3V2a.5.5 0 01.5-.5h5a.5.5 0 01.5.5v5.5a.5.5 0 01-.5.5H8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
                        }
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div ref={logEndRef} />
          </div>}

          {/* Panel footer — log commands only */}
          {!isInteractive && (
            <div className="flex items-center gap-3 px-4 py-2 border-t border-white/[0.05] shrink-0 select-none">
              <span className="text-[10px] text-zinc-700 font-mono">
                {logQuery || levelFilter !== "all"
                  ? `Showing ${filteredLines.length} of ${selectedLogs.length} lines`
                  : `${selectedLogs.length} lines`}
              </span>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-red-400/50">● ERR</span>
                <span className="text-amber-400/50">● WARN</span>
                <span className="text-emerald-400/50">● OK</span>
                <span className="text-blue-400/50">● INFO</span>
              </div>
              <div className="flex-1" />
              <span className="text-[10px] text-zinc-700">⌘F search · Esc close</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
