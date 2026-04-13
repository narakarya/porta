import type { StateCreator } from "zustand";
import type { Service } from "../../types";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ServiceSlice {
  services: Service[];
  serviceLogs: Record<string, string[]>;

  loadServices: () => Promise<void>;
  addService: (params: Parameters<typeof cmd.addService>[0]) => Promise<void>;
  updateService: (id: string, params: Parameters<typeof cmd.updateService>[1]) => Promise<void>;
  deleteService: (id: string) => Promise<void>;
  startService: (id: string) => void;
  stopService: (id: string) => Promise<void>;
  clearServiceLogs: (id: string) => void;
  reorderServices: (fromIndex: number, toIndex: number) => void;
}

export const createServiceSlice: StateCreator<AllSlices, [], [], ServiceSlice> = (set, get) => ({
  services: [],
  serviceLogs: {},

  loadServices: async () => {
    const services = await cmd.listServices();
    set({ services });
  },

  addService: async (params) => {
    const svc = await cmd.addService(params);
    set((s) => ({ services: [...s.services, svc] }));
  },

  updateService: async (id, params) => {
    const updated = await cmd.updateService(id, params);
    set((s) => ({
      services: s.services.map((svc) => (svc.id === id ? updated : svc)),
    }));
  },

  deleteService: async (id) => {
    await cmd.deleteService(id);
    set((s) => ({
      services: s.services.filter((svc) => svc.id !== id),
      serviceLogs: Object.fromEntries(
        Object.entries(s.serviceLogs).filter(([k]) => k !== id)
      ),
    }));
  },

  startService: async (id) => {
    set((s) => ({
      services: s.services.map((svc) =>
        svc.id === id ? { ...svc, status: "pulling" as const } : svc
      ),
      serviceLogs: { ...s.serviceLogs, [id]: [] },
    }));

    if (isTauri) {
      await cmd.startService(id);
    } else {
      cmd.startService(id, (status, containerId) => {
        set((s) => ({
          services: s.services.map((svc) =>
            svc.id === id ? { ...svc, status, container_id: containerId } : svc
          ),
        }));
      });
    }
  },

  stopService: async (id) => {
    await cmd.stopService(id);
    set((s) => ({
      services: s.services.map((svc) =>
        svc.id === id ? { ...svc, status: "stopped" as const, container_id: null } : svc
      ),
    }));
  },

  clearServiceLogs: (id) =>
    set((s) => ({ serviceLogs: { ...s.serviceLogs, [id]: [] } })),

  reorderServices: (fromIndex, toIndex) => {
    const list = [...get().services];
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    set({ services: list });
    cmd.reorderServices(list.map((s) => s.id));
  },
});
