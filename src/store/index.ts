import { create } from "zustand";
import { createWorkspaceSlice, type WorkspaceSlice } from "./slices/workspace";
import { createAppSlice, type AppSlice } from "./slices/app";
import { createServiceSlice, type ServiceSlice } from "./slices/service";
import { createDeploySlice, type DeploySlice } from "./slices/deploy";
import { createUiSlice, type UiSlice } from "./slices/ui";
import { subscribeToAppEvents } from "./subscriptions";

export type AllSlices = WorkspaceSlice & AppSlice & ServiceSlice & DeploySlice & UiSlice & {
  _subscribeToAppEvents: () => () => void;
};

// Re-export types that other files import from store
export type { KamalCmdState, AppDeploySession } from "./slices/deploy";
export { MAX_LOG_LINES } from "./slices/app";

export const usePortaStore = create<AllSlices>((...a) => ({
  ...createWorkspaceSlice(...a),
  ...createAppSlice(...a),
  ...createServiceSlice(...a),
  ...createDeploySlice(...a),
  ...createUiSlice(...a),
  _subscribeToAppEvents: () => {
    const [set, get] = [a[0], a[1]];
    return subscribeToAppEvents(get, set);
  },
}));
