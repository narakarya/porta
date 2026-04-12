import { useState } from "react";
import type { DeploymentConfig, DeployEnvironment, DeployRole } from "../types";

interface Props {
  deployment: DeploymentConfig | null;
}

const STATUS_DOT: Record<DeployEnvironment["status"], string> = {
  live:      "bg-emerald-400",
  stale:     "bg-amber-400",
  failed:    "bg-red-400",
  deploying: "bg-blue-400 pulse-dot",
  unknown:   "bg-zinc-500",
};

const STATUS_LABEL: Record<DeployEnvironment["status"], string> = {
  live:      "Live",
  stale:     "Stale",
  failed:    "Failed",
  deploying: "Deploying",
  unknown:   "Unknown",
};

const ROLE_DOT: Record<DeployRole["status"], string> = {
  live:   "bg-emerald-400",
  stale:  "bg-amber-400",
  failed: "bg-red-400",
};

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DeploymentView({ deployment }: Props) {
  const [selectedEnvName, setSelectedEnvName] = useState(
    deployment?.environments[0]?.name ?? ""
  );

  if (!deployment) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-10 h-10 rounded-xl bg-white/[0.04] flex items-center justify-center mb-3">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="text-zinc-600">
            <path d="M9 2v14M2 9h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <rect x="2" y="2" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        </div>
        <p className="text-[13px] text-zinc-500">No deployment config</p>
        <p className="text-[12px] text-zinc-600 mt-1 max-w-[220px]">
          Kamal deployment support is coming. Add a <code className="text-zinc-500">deploy.yml</code> to your workspace to get started.
        </p>
      </div>
    );
  }

  const env = deployment.environments.find((e) => e.name === selectedEnvName);

  return (
    <div>
      {/* Header */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-[17px] font-semibold text-zinc-100 leading-tight">
            Deployment
          </h1>
          <p className="text-[12px] text-zinc-500 mt-0.5">
            Kamal &middot; {deployment.config_path}
          </p>
        </div>

        {/* Environment selector */}
        <select
          value={selectedEnvName}
          onChange={(e) => setSelectedEnvName(e.target.value)}
          className="text-[12px] bg-white/[0.05] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-zinc-300 focus:outline-none focus:border-white/[0.15] transition-colors"
        >
          {deployment.environments.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name.charAt(0).toUpperCase() + e.name.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {env && (
        <>
          {/* Environment status card */}
          <div className="rounded-lg bg-[#1c1c1e] border border-white/[0.06] mb-3">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
              <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[env.status]}`} />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-zinc-100">
                  {env.name.charAt(0).toUpperCase() + env.name.slice(1)}
                </p>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  {STATUS_LABEL[env.status]}
                  {env.deployed_version && (
                    <span className="ml-2 font-mono text-zinc-600">
                      {env.deployed_version.slice(0, 7)}
                    </span>
                  )}
                  <span className="ml-2">&middot; {formatDate(env.last_deployed_at)}</span>
                </p>
              </div>
            </div>

            {/* Roles */}
            <div className="divide-y divide-white/[0.04]">
              {env.roles.map((role) => (
                <div key={role.name} className="flex items-center gap-3 px-4 py-2.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ROLE_DOT[role.status]}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] text-zinc-300">{role.name}</p>
                  </div>
                  <span className="text-[10px] text-zinc-600 font-mono">
                    {role.version?.slice(0, 7) ?? "---"}
                  </span>
                  <span className="text-[10px] text-zinc-500 tabular-nums">
                    {role.instances} {role.instances === 1 ? "instance" : "instances"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 mt-4">
            <button
              disabled
              className="px-3.5 py-2 text-[12px] font-medium text-blue-400 bg-blue-500/10 rounded-lg opacity-40 cursor-not-allowed"
              title="Kamal CLI integration coming soon"
            >
              Deploy to {env.name}
            </button>
            <button
              disabled
              className="px-3.5 py-2 text-[12px] font-medium text-zinc-400 bg-white/[0.05] rounded-lg opacity-40 cursor-not-allowed"
              title="Coming soon"
            >
              Rollback
            </button>
          </div>
          {env.status === "unknown" && (
            <p className="text-[11px] text-zinc-600 mt-2">
              Status unknown — Porta detected your <code className="text-zinc-500">deploy.yml</code> but hasn't queried your servers yet. Kamal CLI integration is coming.
            </p>
          )}
        </>
      )}
    </div>
  );
}
