import { create } from "zustand";
import { createWorkspaceSlice, type WorkspaceSlice } from "./slices/workspace";
import { createAppSlice, type AppSlice } from "./slices/app";
import { createServiceSlice, type ServiceSlice } from "./slices/service";
import { createUiSlice, type UiSlice } from "./slices/ui";
import { createRemoteSlice, type RemoteSlice } from "./slices/remote";
import { subscribeToAppEvents } from "./subscriptions";

export type AllSlices = WorkspaceSlice & AppSlice & ServiceSlice & UiSlice & RemoteSlice & {
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
  _subscribeToAppEvents: () => {
    const [set, get] = [a[0], a[1]];
    return subscribeToAppEvents(get, set);
  },
}));
