import type { App } from "../../types";
import DeployCustomCmdForm, { type CustomForm } from "./DeployCustomCmdForm";

type CommandDef = {
  id: string;
  label: string;
  args: string[];
  group: "Deploy" | "App" | "Console" | "Server" | "Debug" | "Accessories" | "Custom";
  confirm?: boolean;
  safe?: boolean;
  interactive?: boolean;
};

type CmdState = {
  logs: string[];
  running: boolean;
  exitCode: number | null;
  startedAt: number | null;
};

export type { CustomForm };

interface DeployCommandSidebarProps {
  app: App;
  configPath: string;
  groups: Map<string, CommandDef[]>;
  cmdStates: Record<string, CmdState>;
  selectedCmdId: string;
  pendingCmdId: string | null;
  cmdSearch: string;
  kamalInstalled: boolean;
  kamalChecking: boolean;
  customForm: CustomForm | null;
  customFormError: string;
  onCmdSearchChange: (q: string) => void;
  onSelectCmd: (id: string) => void;
  onRunCmd: (cmd: CommandDef) => void;
  onEditCustomCmd: (form: CustomForm) => void;
  onDeleteCustomCmd: (rawId: string) => void;
  onSaveCustomCmd: () => void;
  onCancelCustomForm: () => void;
  onCustomFormChange: (form: CustomForm) => void;
  onAddCustomCmd: () => void;
  onInstallKamal: () => void;
}

export default function DeployCommandSidebar({
  app,
  configPath,
  groups,
  cmdStates,
  selectedCmdId,
  pendingCmdId,
  cmdSearch,
  kamalInstalled,
  kamalChecking,
  customForm,
  customFormError,
  onCmdSearchChange,
  onSelectCmd,
  onRunCmd,
  onEditCustomCmd,
  onDeleteCustomCmd,
  onSaveCustomCmd,
  onCancelCustomForm,
  onCustomFormChange,
  onAddCustomCmd,
  onInstallKamal,
}: DeployCommandSidebarProps) {
  const notInstalled = !kamalInstalled || kamalChecking;

  return (
    <div className="w-[200px] shrink-0 border-r border-white/[0.06] flex flex-col bg-[#0f0f11]">

      {/* Sidebar search */}
      <div className="px-3 py-2.5 border-b border-white/[0.05]">
        <div className="relative">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none">
            <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M8 8l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <input spellCheck={false}
            value={cmdSearch}
            onChange={e => onCmdSearchChange(e.target.value)}
            placeholder="Filter commands…"
            className="w-full bg-white/[0.04] border border-white/[0.06] rounded-md pl-6 pr-2 py-1.5 text-[11px] text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-blue-500/40 transition-colors"
          />
        </div>
      </div>

      {/* Command groups */}
      <div className="flex-1 overflow-y-auto py-1">
        {Array.from(groups.entries()).map(([group, cmds]) => (
          <div key={group} className="mb-1">
            <div className="px-3 py-1.5 text-[9px] font-semibold text-zinc-600 uppercase tracking-wider select-none">
              {group}
            </div>
            {cmds.map(cmd => {
              const st = cmdStates[cmd.id];
              const isSelected = selectedCmdId === cmd.id;
              const isRunning  = st?.running ?? false;
              const isPending  = pendingCmdId === cmd.id;

              return (
                <div key={cmd.id} className="group relative flex items-center">
                  <button
                    onClick={() => {
                      onSelectCmd(cmd.id);
                      if (!isSelected) return; // first click = select only
                      onRunCmd(cmd);            // second click on already-selected = run
                    }}
                    disabled={notInstalled}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
                      isSelected
                        ? "bg-white/[0.07] text-zinc-100"
                        : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                    } ${notInstalled ? "opacity-40 cursor-not-allowed" : ""}`}
                  >
                    {/* Status dot */}
                    <span className="shrink-0 w-3.5 flex items-center justify-center">
                      {isRunning ? (
                        <span className="w-2.5 h-2.5 border border-blue-400 border-t-transparent rounded-full animate-spin" />
                      ) : st?.exitCode === 0 ? (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      ) : st?.exitCode != null ? (
                        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                      ) : (
                        <span className="w-1 h-1 rounded-full bg-zinc-700" />
                      )}
                    </span>

                    <span className="flex-1 truncate">{cmd.label}</span>

                    {/* Pending or action hint */}
                    {isPending && (
                      <span className="shrink-0 text-[9px] text-amber-400 font-medium">?</span>
                    )}
                    {!isPending && isSelected && !isRunning && (
                      <span className="shrink-0 text-[9px] text-zinc-600 opacity-0 group-hover:opacity-100">↵</span>
                    )}
                  </button>
                  {cmd.group === "Custom" && (
                    <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const rawId = cmd.id.replace(/^custom-/, "");
                          const raw = app.deploy_custom_commands?.find(c => c.id === rawId);
                          if (raw) onEditCustomCmd({ id: raw.id, label: raw.label, rawArgs: raw.args.join(" "), interactive: raw.interactive });
                        }}
                        className="text-zinc-500 hover:text-zinc-300 px-1 py-0.5 text-xs rounded"
                        title="Edit"
                      >
                        ✎
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteCustomCmd(cmd.id.replace(/^custom-/, ""));
                        }}
                        className="text-zinc-500 hover:text-red-400 px-1 py-0.5 text-xs rounded"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Custom command form */}
      {customForm && (
        <DeployCustomCmdForm
          form={customForm}
          error={customFormError}
          onChange={onCustomFormChange}
          onSave={onSaveCustomCmd}
          onCancel={onCancelCustomForm}
        />
      )}
      {!customForm && (
        <div className="border-t border-white/5 p-2">
          <button
            onClick={onAddCustomCmd}
            className="w-full text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded px-2 py-1.5 text-left transition-colors"
          >
            + Add command
          </button>
        </div>
      )}

      {/* Sidebar footer: config path + install */}
      <div className="border-t border-white/[0.05] px-3 py-2 space-y-2">
        <div className="flex items-start gap-1.5">
          <span className="text-[9px] text-zinc-700 uppercase tracking-wide shrink-0 mt-[1px]">cfg</span>
          <code className="text-[10px] text-zinc-600 font-mono break-all leading-tight">{configPath || "—"}</code>
        </div>
        {!kamalChecking && !kamalInstalled && (
          <button
            onClick={onInstallKamal}
            className="w-full px-2 py-1.5 rounded-md text-[11px] font-medium bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors"
          >
            Install Kamal
          </button>
        )}
      </div>
    </div>
  );
}
