import { useEffect } from "react";
import { usePortaStore } from "./store";
import Layout from "./components/Layout";
import WorkspaceView from "./components/WorkspaceView";
import SetupWizard from "./components/SetupWizard";

export default function App() {
  const { load, checkSetup } = usePortaStore();

  useEffect(() => {
    checkSetup();
    load();
  }, []);

  return (
    <>
      <SetupWizard />
      <Layout>
        <WorkspaceView />
      </Layout>
    </>
  );
}
