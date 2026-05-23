import type { StateCreator } from "zustand";
import type { Service, ServiceTemplate } from "../../types";
import type { AllSlices } from "../index";
import * as cmd from "../../lib/commands";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ServiceSlice {
  services: Service[];
  serviceLogs: Record<string, string[]>;
  serviceTemplates: ServiceTemplate[];

  loadServices: () => Promise<void>;
  addService: (params: Parameters<typeof cmd.addService>[0]) => Promise<void>;
  updateService: (id: string, params: Parameters<typeof cmd.updateService>[1]) => Promise<void>;
  deleteService: (id: string) => Promise<void>;
  startService: (id: string) => void;
  stopService: (id: string) => Promise<void>;
  clearServiceLogs: (id: string) => void;
  reorderServices: (fromIndex: number, toIndex: number) => void;

  loadServiceTemplates: () => Promise<void>;
  saveServiceTemplate: (template: ServiceTemplate) => Promise<void>;
  deleteServiceTemplate: (id: string) => Promise<void>;
}

export const createServiceSlice: StateCreator<AllSlices, [], [], ServiceSlice> = (set, get) => ({
  services: [],
  serviceLogs: {},
  serviceTemplates: [],

  loadServices: async () => {
    const services = await cmd.listServices();
    set({ services });
  },

  loadServiceTemplates: async () => {
    const serviceTemplates = await cmd.listServiceTemplates();
    set({ serviceTemplates });
  },

  saveServiceTemplate: async (template) => {
    const saved = await cmd.saveServiceTemplate(template);
    set((s) => {
      const idx = s.serviceTemplates.findIndex((t) => t.id === saved.id);
      const next = idx === -1
        ? [...s.serviceTemplates, saved]
        : s.serviceTemplates.map((t) => t.id === saved.id ? saved : t);
      return { serviceTemplates: next };
    });
  },

  deleteServiceTemplate: async (id) => {
    await cmd.deleteServiceTemplate(id);
    set((s) => ({ serviceTemplates: s.serviceTemplates.filter((t) => t.id !== id) }));
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
