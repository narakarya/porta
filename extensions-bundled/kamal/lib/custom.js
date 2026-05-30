const KEY = "customCommands";

export class CustomStore {
  constructor(storage) { this.storage = storage; }

  async list() {
    const v = await this.storage.get(KEY);
    return Array.isArray(v) ? v : [];
  }
  async add({ label, args, interactive }) {
    const list = await this.list();
    list.push({ id: crypto.randomUUID(), label, args, interactive: !!interactive });
    await this.storage.set(KEY, list);
  }
  async update(id, { label, args, interactive }) {
    const list = await this.list();
    const i = list.findIndex((c) => c.id === id);
    if (i === -1) return;
    list[i] = { id, label, args, interactive: !!interactive };
    await this.storage.set(KEY, list);
  }
  async remove(id) {
    const list = (await this.list()).filter((c) => c.id !== id);
    await this.storage.set(KEY, list);
  }
  toCommandDefs(list) {
    return list.map((c) => ({
      id: `custom-${c.id}`,
      label: c.label,
      args: c.args,
      group: "Custom",
      interactive: c.interactive,
    }));
  }
}
