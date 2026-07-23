import { create } from "zustand";
import { createWorkspaceSlice, type WorkspaceSlice } from "./slices/workspace";
import { createAppSlice, type AppSlice } from "./slices/app";
import { createServiceSlice, type ServiceSlice } from "./slices/service";
import { createUiSlice, type UiSlice } from "./slices/ui";
import { createRemoteSlice, type RemoteSlice } from "./slices/remote";
import { createSshSlice, type SshSlice } from "./slices/ssh";
import { createNotifySlice, type NotifySlice } from "./slices/notify";
import { createTerminalSlice, type TerminalSlice } from "./slices/terminal";
import { subscribeToAppEvents } from "./subscriptions";

export type AllSlices = WorkspaceSlice & AppSlice & ServiceSlice & UiSlice & RemoteSlice & SshSlice & NotifySlice & TerminalSlice & {
  _subscribeToAppEvents: () => () => void;
};

// Re-export types that other files import from store
export { MAX_LOG_LINES } from "./slices/app";

export const usePortaStore = create<AllSlices>((...a) => ({
  ...createWorkspaceSlice(...a),
  ...createAppSlice(...a),
  ...createServiceSlice(...a),
  ...createUiSlice(...a),
  ...createRemoteSlice(...a),
  ...createSshSlice(...a),
  ...createNotifySlice(...a),
  ...createTerminalSlice(...a),
  _subscribeToAppEvents: () => {
    const [set, get] = [a[0], a[1]];
    return subscribeToAppEvents(get, set);
  },
}));

// Dev-only handle for Tidewave Web `browser_eval` — inspecting or driving store
// state from the MCP session otherwise means adding a temporary export every
// time. Stripped from production builds by the `import.meta.env.DEV` guard.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { portaStore: typeof usePortaStore }).portaStore = usePortaStore;
}
