const b = window.portaBridge;
const out = document.getElementById("out");
const log = (m) => { out.textContent += m + "\n"; };

document.getElementById("store").onclick = async () => {
  await b.storage.set("greeting", { hi: "there", n: 1 });
  const v = await b.storage.get("greeting");
  const keys = await b.storage.keys();
  log("storage.get -> " + JSON.stringify(v));
  log("storage.keys -> " + JSON.stringify(keys));
  await b.storage.remove("greeting");
  log("after remove keys -> " + JSON.stringify(await b.storage.keys()));
};

document.getElementById("term").onclick = async () => {
  const id = "t1";
  const dec = new TextDecoder();
  b.terminal.onData(id, (bytes) => log("term: " + dec.decode(bytes).trim()));
  b.terminal.onExit(id, () => log("term exited"));
  await b.terminal.open(id, { cwd: b.app.rootDir, rows: 24, cols: 80 });
  setTimeout(() => {
    b.terminal.write(id, new TextEncoder().encode("echo hello-from-pty\r"));
  }, 300);
};
