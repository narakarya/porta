import { useMemo, useState } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  ClockCounterClockwise,
  Package,
  RocketLaunch,
  ShieldCheck,
  TerminalWindow,
  WarningCircle,
} from "@phosphor-icons/react";
import type { App } from "../../types";
import type { ExtensionInfo } from "../../types/extension";

type ExtensionTool = "deploy" | "packages";

const PACKAGES = [
  { name: "phoenix", current: "1.7.19", latest: "1.7.20", status: "update" },
  { name: "ecto_sql", current: "3.12.1", latest: "3.12.1", status: "current" },
  { name: "bandit", current: "1.5.9", latest: "1.6.0", status: "update" },
  { name: "swoosh", current: "1.17.5", latest: "1.17.5", status: "current" },
];

interface Props {
  app: App;
  tool: ExtensionTool;
  extension: ExtensionInfo | null;
  onOpenExtensions: () => void;
  onOpenTerminal: (command: string) => void;
}

export default function WorkbenchExtensionPreview({ app, tool, extension, onOpenExtensions, onOpenTerminal }: Props) {
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const filteredPackages = useMemo(
    () => PACKAGES.filter((item) => item.name.includes(query.trim().toLowerCase())),
    [query],
  );

  if (!extension) {
    const Icon = tool === "deploy" ? RocketLaunch : Package;
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div className="max-w-sm rounded-xl border border-white/[0.07] bg-white/[0.025] p-6">
          <Icon size={26} className="mx-auto text-violet-400" />
          <p className="mt-3 text-[13px] font-medium text-zinc-200">{tool === "deploy" ? "Kamal Deploy" : "Phoenix Package Manager"} is not active</p>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">Install or enable the extension to attach its tools to compatible apps.</p>
          <button onClick={onOpenExtensions} className="mt-4 rounded-lg bg-violet-500/15 px-3 py-1.5 text-[11px] font-medium text-violet-300 hover:bg-violet-500/25">Open Extensions</button>
        </div>
      </div>
    );
  }

  const runPreviewAction = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2400);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#101214]">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/[0.08] px-4">
        {tool === "deploy" ? <RocketLaunch size={16} className="text-violet-400" /> : <Package size={16} className="text-amber-400" />}
        <span className="text-[13px] font-semibold text-zinc-200">{extension.name}</span>
        <span className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[9px] text-zinc-600">v{extension.version}</span>
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-[10px] text-emerald-400"><CheckCircle size={12} weight="fill" /> Enabled for {app.name}</span>
        <button onClick={onOpenExtensions} className="rounded-md border border-white/[0.08] px-2.5 py-1.5 text-[10px] text-zinc-400 hover:bg-white/[0.05]">Manage extension</button>
      </div>

      {notice && <div className="border-b border-emerald-500/15 bg-emerald-500/[0.07] px-4 py-2 text-[11px] text-emerald-300">{notice}</div>}

      {tool === "deploy" ? (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <div className="mx-auto max-w-5xl">
            <div className="grid grid-cols-3 gap-3">
              <Summary label="Environment" value="Production" detail="primary · deploy.yml" />
              <Summary label="Last deploy" value="Healthy" detail="a13f0c2 · 18 min ago" tone="green" />
              <Summary label="Hosts" value="2 / 2 online" detail="web · worker" tone="green" />
            </div>
            <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02]">
              <div className="flex items-center border-b border-white/[0.07] px-4 py-3">
                <div><p className="text-[13px] font-medium text-zinc-200">Deploy {app.name}</p><p className="mt-0.5 text-[10px] text-zinc-600">Build, push, release, and verify the current branch.</p></div>
                <span className="flex-1" />
                <button onClick={() => onOpenTerminal("kamal app logs -f")} className="mr-2 flex items-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-2 text-[11px] text-zinc-400"><TerminalWindow size={12} /> Live logs</button>
                <button onClick={() => runPreviewAction("Deployment queued for production")} className="flex items-center gap-1.5 rounded-md bg-violet-500/15 px-3 py-2 text-[11px] font-medium text-violet-300"><RocketLaunch size={12} /> Deploy now</button>
              </div>
              <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 text-[11px]">
                <div><p className="text-zinc-300">a13f0c2 · feat: sync teacher profile</p><p className="mt-1 text-zinc-600">nasrul · production · 2 hosts · 41s</p></div>
                <button onClick={() => runPreviewAction("Rollback prepared; confirmation required in the extension host")} className="flex items-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-1.5 text-zinc-400"><ClockCounterClockwise size={12} /> Roll back</button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <div className="mx-auto max-w-5xl">
            <div className="flex items-center gap-2">
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter dependencies…" className="h-8 w-72 rounded-md border border-white/[0.08] bg-[#0d0f11] px-3 text-[11px] text-zinc-200 outline-none" />
              <button onClick={() => runPreviewAction("Dependency check completed: 2 updates available")} className="flex items-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-2 text-[10px] text-zinc-400"><ArrowsClockwise size={12} /> Check updates</button>
              <button onClick={() => runPreviewAction("Security audit completed: no known vulnerabilities")} className="flex items-center gap-1.5 rounded-md border border-white/[0.08] px-3 py-2 text-[10px] text-zinc-400"><ShieldCheck size={12} /> Audit</button>
              <button onClick={() => onOpenTerminal("mix deps.update --all")} className="ml-auto flex items-center gap-1.5 rounded-md bg-amber-500/15 px-3 py-2 text-[10px] text-amber-300"><TerminalWindow size={12} /> Update in terminal</button>
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border border-white/[0.07]">
              <div className="grid grid-cols-[1fr_120px_120px_110px] bg-white/[0.025] px-4 py-2 text-[9px] font-semibold uppercase tracking-widest text-zinc-600"><span>Package</span><span>Installed</span><span>Latest</span><span>Status</span></div>
              {filteredPackages.map((item) => <div key={item.name} className="grid grid-cols-[1fr_120px_120px_110px] items-center border-t border-white/[0.06] px-4 py-3 font-mono text-[11px] text-zinc-400"><span className="text-zinc-200">{item.name}</span><span>{item.current}</span><span>{item.latest}</span><span className={item.status === "current" ? "text-emerald-400" : "text-amber-400"}>{item.status === "current" ? "Current" : "Update"}</span></div>)}
              {filteredPackages.length === 0 && <div className="flex items-center justify-center gap-2 px-4 py-8 text-[11px] text-zinc-600"><WarningCircle size={13} /> No matching dependencies</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Summary({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: "green" }) {
  return <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"><p className="text-[9px] font-semibold uppercase tracking-widest text-zinc-600">{label}</p><p className={`mt-2 text-[15px] font-semibold ${tone === "green" ? "text-emerald-300" : "text-zinc-200"}`}>{value}</p><p className="mt-1 text-[10px] text-zinc-600">{detail}</p></div>;
}
