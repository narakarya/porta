import { useEffect, useState } from "react";
import { usePortaStore } from "./store";
import { reloadCaddy } from "./lib/commands";
import Layout from "./components/Layout";
import WorkspaceView from "./components/WorkspaceView";
import SetupWizard from "./components/SetupWizard";
import SettingsPage from "./components/SettingsPage";

type Page = "main" | "settings";

export default function App() {
  const { load, checkSetup, _subscribeToAppEvents } = usePortaStore();
  const [page, setPage] = useState<Page>("main");

  useEffect(() => {
    checkSetup();
    load();
    reloadCaddy().catch(() => {});
    const unsubscribe = _subscribeToAppEvents();
    return unsubscribe;
  }, []);

  if (page === "settings") {
    return <SettingsPage onBack={() => setPage("main")} />;
  }

  return (
    <>
      <SetupWizard />
      <Layout onOpenSettings={() => setPage("settings")}>
        <WorkspaceView />
      </Layout>
    </>
  );
}
