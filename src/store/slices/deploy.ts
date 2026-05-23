import type { StateCreator } from "zustand";
import type { AllSlices } from "../index";

export interface KamalCmdState {
  logs: string[];
  running: boolean;
  exitCode: number | null;
  startedAt: number | null;
  runId: string | null;
}

export interface AppDeploySession {
  cmdStates: Record<string, KamalCmdState>;
  selectedCmdId: string;
}

export interface DeploySlice {
  deploySessions: Record<string, AppDeploySession>;
  setDeploySelectedCmd: (appId: string, cmdId: string) => void;
  updateDeployCmdState: (appId: string, cmdId: string, patch: Partial<KamalCmdState>) => void;
  appendDeployLog: (appId: string, cmdId: string, line: string) => void;
}

export const createDeploySlice: StateCreator<AllSlices, [], [], DeploySlice> = (set) => ({
  deploySessions: {},

  setDeploySelectedCmd: (appId, cmdId) =>
    set((s) => ({
      deploySessions: {
        ...s.deploySessions,
        [appId]: {
          ...(s.deploySessions[appId] ?? { cmdStates: {} }),
          selectedCmdId: cmdId,
        },
      },
    })),

  updateDeployCmdState: (appId, cmdId, patch) =>
    set((s) => {
      const session = s.deploySessions[appId] ?? { cmdStates: {}, selectedCmdId: "" };
      const prev = session.cmdStates[cmdId] ?? { logs: [], running: false, exitCode: null, startedAt: null, runId: null };
      return {
        deploySessions: {
          ...s.deploySessions,
          [appId]: {
            ...session,
            cmdStates: { ...session.cmdStates, [cmdId]: { ...prev, ...patch } },
          },
        },
      };
    }),

  appendDeployLog: (appId, cmdId, line) =>
    set((s) => {
      const session = s.deploySessions[appId] ?? { cmdStates: {}, selectedCmdId: "" };
      const prev = session.cmdStates[cmdId] ?? { logs: [], running: false, exitCode: null, startedAt: null, runId: null };
      return {
        deploySessions: {
          ...s.deploySessions,
          [appId]: {
            ...session,
            cmdStates: {
              ...session.cmdStates,
              [cmdId]: { ...prev, logs: [...prev.logs, line] },
            },
          },
        },
      };
    }),
});
