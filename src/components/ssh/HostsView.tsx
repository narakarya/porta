import { useEffect, useState } from "react";
import { usePortaStore } from "../../store";
import { Skeleton } from "../ui";
import { SidebarFrame, SidebarHeader, SidebarBody } from "../layout/SidebarShell";
import HostVault from "./HostVault";
import SshSessionTabs from "./SshSessionTabs";
import TrustHostModal from "./TrustHostModal";
import SecretPromptModal from "./SecretPromptModal";

/** Sidebar placeholder shown on first load, before the host list arrives.
 *  Mirrors HostVault's shell (header + search row + rows) so the swap to real
 *  content doesn't shift. */
function HostVaultSkeleton() {
  return (
    <>
      <SidebarHeader>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-ink leading-tight">Hosts</div>
          <Skeleton className="h-2.5 w-16 rounded mt-1.5" />
        </div>
      </SidebarHeader>
      <div className="px-2.5 pb-2 shrink-0">
        <Skeleton className="h-7 w-full rounded-control" />
      </div>
      <SidebarBody className="flex flex-col gap-0.5 px-2 pt-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 px-2 py-1.5">
            <Skeleton className="w-5 h-5 rounded" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3 w-24 rounded mb-1" />
              <Skeleton className="h-2.5 w-32 rounded" />
            </div>
          </div>
        ))}
      </SidebarBody>
    </>
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
    <div className="flex h-screen -mx-6 -mt-6 -mb-6 bg-surface-0">
      {/* Reuse the same shell the Workspaces sidebar uses (216px, #0d0d0f,
          shared border) instead of a hand-rolled 256px column. */}
      <SidebarFrame>
        {showSkeleton ? <HostVaultSkeleton /> : <HostVault />}
      </SidebarFrame>
      <div className="flex-1 min-w-0 h-full flex flex-col bg-surface-0">
        <SshSessionTabs />
      </div>
      <TrustHostModal />
      <SecretPromptModal />
    </div>
  );
}
