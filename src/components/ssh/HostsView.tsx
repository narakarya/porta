import { useEffect } from "react";
import { usePortaStore } from "../../store";
import HostVault from "./HostVault";
import SshSessionTabs from "./SshSessionTabs";

export default function HostsView() {
  const loadSshHosts = usePortaStore((s) => s.loadSshHosts);
  useEffect(() => {
    loadSshHosts();
  }, [loadSshHosts]);

  return (
    <div className="flex h-[calc(100vh-56px)] -mx-6 -mt-14 pt-14">
      <div className="w-64 shrink-0 border-r border-white/[0.06] overflow-y-auto">
        <HostVault />
      </div>
      <div className="flex-1 min-w-0">
        <SshSessionTabs />
      </div>
    </div>
  );
}
