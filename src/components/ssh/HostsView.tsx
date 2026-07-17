import { useEffect, useState } from "react";
import { usePortaStore } from "../../store";
import { Skeleton } from "../ui";
import HostVault from "./HostVault";
import SshSessionTabs from "./SshSessionTabs";
import TrustHostModal from "./TrustHostModal";
import SecretPromptModal from "./SecretPromptModal";

/** Sidebar placeholder shown on first load, before the host list arrives.
 *  Mirrors HostVault's top layout (label + search row + rows) so the swap to
 *  real content doesn't shift. */
function HostVaultSkeleton() {
  return (
    <div className="p-2">
      <div className="px-1 mb-2 text-[11px] uppercase tracking-[0.04em] text-ink-3">Hosts</div>
      <div className="flex items-center gap-1.5 mb-2">
        <Skeleton className="h-7 flex-1 rounded-lg" />
      </div>
      <div className="flex flex-col gap-0.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 px-2 py-1.5">
            <Skeleton className="w-1.5 h-1.5 rounded-full" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3 w-24 rounded mb-1" />
              <Skeleton className="h-2.5 w-32 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HostsView() {
  const hosts = usePortaStore((s) => s.sshHosts);
  const loadSshHosts = usePortaStore((s) => s.loadSshHosts);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadSshHosts().finally(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [loadSshHosts]);

  const showSkeleton = loading && hosts.length === 0;

  return (
    <div className="flex h-screen -mx-6 -mt-14 pt-14 -mb-6 bg-surface-0">
      <div className="w-64 shrink-0 h-full flex flex-col border-r border-subtle bg-surface-1 overflow-y-auto">
        {showSkeleton ? <HostVaultSkeleton /> : <HostVault />}
      </div>
      <div className="flex-1 min-w-0 h-full flex flex-col bg-surface-0">
        <SshSessionTabs />
      </div>
      <TrustHostModal />
      <SecretPromptModal />
    </div>
  );
}
