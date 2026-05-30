import { kamalWorkDir } from "./lib/workdir.js";
import { parseAccessories } from "./lib/accessories.js";
import { FIXED_COMMANDS, buildAccessoryCommands, groupCommands } from "./lib/commands.js";
import { CustomStore } from "./lib/custom.js";
import { detectConfigPath } from "./lib/config.js";
import { KamalTerminal } from "./lib/term.js";

const bridge = window.portaBridge;
const $ = (id) => document.getElementById(id);

if (!bridge) {
  document.body.textContent = "Missing portaBridge. Reload the extension.";
  throw new Error("kamal: no portaBridge");
}

const sidebarEl = $("sidebar");
const statusEl = $("status-bar");
const termHostEl = $("term-host");

const rootDir = bridge.app.rootDir;
const custom = new CustomStore(bridge.storage);
const runShell = (cmd) => bridge.shell.run(cmd);

const SEARCH_THRESHOLD = 12; // show the filter box once the list is long

// Mirrors src-tauri/src/commands/deploy.rs `install_kamal`: use
// `gem install kamal` when the gemdir is writable, else fall back to
// `gem install kamal --user-install`. The extension can't call libc, so the
// writability check is done in shell.
const INSTALL_CMD =
  'if [ -w "$(gem env gemdir 2>/dev/null)" ]; then gem install kamal; else gem install kamal --user-install; fi';

const state = {
  installed: false,
  version: null,
  configPath: null,
  workDir: rootDir,
  accessories: [],
  commands: [],
  search: "",
  selectedId: null,
  editingCustomId: null, // null = not editing; "" = adding new
};
let term = null;
let termCounter = 0;

bridge.ui.setTitle("Kamal — " + bridge.app.name);

// ── data loading ──────────────────────────────────────────────────────────
async function checkKamal() {
  const r = await runShell("kamal version");
  state.installed = r.code === 0;
  state.version = state.installed ? (r.stdout.trim().split("\n").pop() || "").trim() : null;
}

async function loadConfig() {
  const override = await bridge.storage.get("configPathOverride");
  const ovr = typeof override === "string" && override ? override : null;
  state.configPath = await detectConfigPath(runShell, rootDir, ovr);
  if (state.configPath) {
    state.workDir = kamalWorkDir(state.configPath);
    const cat = await runShell(`cat '${state.configPath}'`);
    state.accessories = cat.code === 0 ? parseAccessories(cat.stdout) : [];
  } else {
    state.workDir = rootDir;
    state.accessories = [];
  }
}

async function rebuildCommands() {
  const customDefs = custom.toCommandDefs(await custom.list());
  state.commands = [...FIXED_COMMANDS, ...buildAccessoryCommands(state.accessories), ...customDefs];
}

// ── terminal ──────────────────────────────────────────────────────────────
function freshTerminal() {
  if (term) { term.dispose(); term = null; }
  termHostEl.innerHTML = "";
  const termId = "kamal-" + (++termCounter);
  term = new KamalTerminal({
    Terminal: window.Terminal,
    FitAddon: window.FitAddon.FitAddon,
    bridge,
    hostEl: termHostEl,
    termId,
  });
  return term;
}

async function runCommand(cmd) {
  if (cmd.confirm && !confirm(`Run: kamal ${cmd.args.join(" ")} ?`)) return;
  state.selectedId = cmd.id;
  const t = freshTerminal();
  try {
    await t.open(state.workDir);
  } catch (err) {
    bridge.ui.toast("Could not open terminal: " + (err && err.message ? err.message : String(err)), "error");
    return;
  }
  // PTY stdin is always wired (KamalTerminal forwards keystrokes), so interactive
  // commands work without branching on cmd.interactive.
  t.run(cmd.args);
  renderStatus();
  renderSidebar();
}

async function installKamal(installCmd) {
  const t = freshTerminal();
  try {
    await t.open(state.workDir);
  } catch (err) {
    bridge.ui.toast("Could not open terminal: " + (err && err.message ? err.message : String(err)), "error");
    return;
  }
  t.runRaw(installCmd);
  // After the shell finishes, the user clicks "Re-check" to refresh status.
  renderStatus();
}

// ── rendering ───────────────────────────────────────────────────────────────
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) node.append(c);
  return node;
}

function renderStatus() {
  statusEl.innerHTML = "";
  const left = el("div", { className: "status-left" });
  if (state.installed) {
    left.append(el("span", { className: "kamal-version", textContent: "kamal " + (state.version || "") }));
  } else {
    left.append(el("span", { className: "kamal-missing", textContent: "kamal not found" }));
    const btn = el("button", { className: "btn", textContent: "Install Kamal" });
    btn.onclick = () => installKamal(INSTALL_CMD);
    left.append(btn);
    const recheck = el("button", { className: "btn", textContent: "Re-check" });
    recheck.onclick = async () => { await checkKamal(); renderStatus(); };
    left.append(recheck);
  }
  const right = el("div", { className: "status-right" });
  const cancel = el("button", { className: "btn", textContent: "Cancel (Ctrl-C)" });
  cancel.onclick = () => term && term.cancel();
  right.append(cancel);
  statusEl.append(left, right);
}

function commandMatches(cmd) {
  if (!state.search) return true;
  return cmd.label.toLowerCase().includes(state.search.toLowerCase());
}

function renderSidebar() {
  // No-config path: full rebuild is fine (no persistent search box).
  if (!state.configPath) {
    sidebarEl.innerHTML = "";
    sidebarEl.append(el("div", { className: "notice", textContent: "No deploy.yml found under " + rootDir }));
    const input = el("input", { className: "cfg-input", placeholder: "/path/to/deploy.yml" });
    const save = el("button", { className: "btn", textContent: "Set config path" });
    save.onclick = async () => {
      const v = input.value.trim();
      if (!v) return;
      await bridge.storage.set("configPathOverride", v);
      await reload();
    };
    sidebarEl.append(input, save);
    return;
  }

  // Build the stable shell (search box + list container) once. Recreating the
  // search input on every keystroke would drop focus, so it lives across
  // renderCommandList() calls.
  let listEl = document.getElementById("sidebar-list");
  if (!listEl) {
    sidebarEl.innerHTML = "";
    if (state.commands.length >= SEARCH_THRESHOLD) {
      const search = el("input", {
        id: "sidebar-search", className: "search",
        placeholder: "Filter commands…", value: state.search,
      });
      search.oninput = (e) => { state.search = e.target.value; renderCommandList(); };
      sidebarEl.append(search);
    }
    listEl = el("div", { id: "sidebar-list" });
    sidebarEl.append(listEl);
  }
  renderCommandList();
}

function renderCommandList() {
  const listEl = document.getElementById("sidebar-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  const groups = groupCommands(state.commands.filter(commandMatches));
  for (const [group, cmds] of groups) {
    listEl.append(el("div", { className: "group-header", textContent: group }));
    for (const cmd of cmds) {
      const row = el("div", {
        className: "cmd-row" + (cmd.id === state.selectedId ? " selected" : ""),
      });
      row.append(el("span", { className: "cmd-label", textContent: cmd.label }));
      row.onclick = () => runCommand(cmd);
      if (cmd.group === "Custom") {
        const id = cmd.id.replace(/^custom-/, "");
        const edit = el("button", { className: "icon-btn", textContent: "✎", title: "Edit" });
        edit.onclick = (e) => { e.stopPropagation(); openCustomForm(id); };
        const del = el("button", { className: "icon-btn", textContent: "✕", title: "Delete" });
        del.onclick = async (e) => { e.stopPropagation(); await custom.remove(id); await rebuildCommands(); renderSidebar(); };
        row.append(edit, del);
      }
      listEl.append(row);
    }
  }

  const addCustom = el("button", { className: "btn add-custom", textContent: "＋ Custom command" });
  addCustom.onclick = () => openCustomForm("");
  listEl.append(addCustom);

  if (state.editingCustomId !== null) listEl.append(renderCustomForm());
}

let _editDraft = null;
async function openCustomForm(id) {
  state.editingCustomId = id;
  if (id) {
    const list = await custom.list();
    const found = list.find((c) => c.id === id);
    _editDraft = found ? { label: found.label, args: found.args.join(" "), interactive: found.interactive } : { label: "", args: "", interactive: false };
  } else {
    _editDraft = { label: "", args: "", interactive: false };
  }
  renderSidebar();
}

function renderCustomForm() {
  const form = el("div", { className: "custom-form" });
  const label = el("input", { className: "cf-label", placeholder: "Label", value: _editDraft.label });
  const args = el("input", { className: "cf-args", placeholder: "args e.g. console", value: _editDraft.args });
  const save = el("button", { className: "btn", textContent: "Save" });
  save.onclick = async () => {
    const payload = {
      label: label.value.trim(),
      args: args.value.trim().split(/\s+/).filter(Boolean),
      // PTY always forwards stdin, so there's no interactive branch; keep the
      // field for data parity (CustomStore defaults it).
      interactive: false,
    };
    if (!payload.label || payload.args.length === 0) return;
    if (state.editingCustomId) await custom.update(state.editingCustomId, payload);
    else await custom.add(payload);
    state.editingCustomId = null;
    await rebuildCommands();
    renderSidebar();
  };
  const cancel = el("button", { className: "btn", textContent: "Cancel" });
  cancel.onclick = () => { state.editingCustomId = null; renderSidebar(); };
  form.append(label, args, save, cancel);
  return form;
}

// ── lifecycle ────────────────────────────────────────────────────────────────
async function reload() {
  await loadConfig();
  await rebuildCommands();
  renderStatus();
  // Reload isn't triggered by typing, so a clean rebuild is safe and lets the
  // search-box shell reflect a changed command count / threshold crossing.
  sidebarEl.innerHTML = "";
  renderSidebar();
}

async function main() {
  try {
    renderStatus();
    sidebarEl.append(el("div", { className: "loading", textContent: "Loading…" }));
    await checkKamal();
    await reload();

    // Keep the terminal sized to its container.
    const ro = new ResizeObserver(() => { if (term) term.resize(); });
    ro.observe(termHostEl);
  } catch (err) {
    sidebarEl.innerHTML = "";
    sidebarEl.append(el("div", { className: "notice", textContent: "Load failed: " + (err && err.message ? err.message : String(err)) }));
  }
}

main();
