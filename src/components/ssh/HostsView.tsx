import { useEffect } from "react";
import { usePortaStore } from "../../store";
import HostVault from "./HostVault";
import SshSessionTabs from "./SshSessionTabs";
import TrustHostModal from "./TrustHostModal";
import SecretPromptModal from "./SecretPromptModal";

export default function HostsView() {
  const loadSshHosts = usePortaStore((s) => s.loadSshHosts);
  useEffect(() => {
    loadSshHosts();
  }, [loadSshHosts]);

  return (
    <div className="flex h-[calc(100vh-56px)] -mx-6 -mt-14 pt-14 bg-[#0d0d0f]">
      <div className="w-64 shrink-0 border-r border-white/[0.08] bg-[#151517] overflow-y-auto">
        <HostVault />
      </div>
      <div className="flex-1 min-w-0 bg-[#0d0d0f]">
        <SshSessionTabs />
      </div>
      <TrustHostModal />
      <SecretPromptModal />
    </div>
  );
}
