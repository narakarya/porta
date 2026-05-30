// KamalTerminal — one xterm bound to one bridge.terminal session.
// deps: Terminal (xterm class), FitAddon (fit-addon class), bridge (window.portaBridge).
export class KamalTerminal {
  constructor({ Terminal, FitAddon, bridge, hostEl, termId }) {
    this.bridge = bridge;
    this.termId = termId;
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", Menlo, monospace',
      fontSize: 12, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
      theme: { background: "#0d0d0f", foreground: "#d4d4d4" },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(hostEl);
    this._unsubs = [];
    this._opened = false;
  }

  async open(cwd) {
    this.fit.fit();
    const d = this.fit.proposeDimensions() || { rows: 24, cols: 80 };
    const dec = new TextDecoder();
    this._unsubs.push(this.bridge.terminal.onData(this.termId, (bytes) => this.term.write(dec.decode(bytes))));
    this._unsubs.push(this.bridge.terminal.onExit(this.termId, () => this.term.writeln("\r\n\x1b[90m— exited —\x1b[0m")));
    // Forward user keystrokes to the PTY (interactive commands).
    this.term.onData((data) => this.bridge.terminal.write(this.termId, new TextEncoder().encode(data)));
    await this.bridge.terminal.open(this.termId, { cwd, rows: d.rows, cols: d.cols });
    this._opened = true;
  }

  // Type a kamal command line into the PTY.
  run(args) {
    const line = "kamal " + args.join(" ") + "\r";
    this.bridge.terminal.write(this.termId, new TextEncoder().encode(line));
  }

  // Run an arbitrary command line (used for install).
  runRaw(line) {
    this.bridge.terminal.write(this.termId, new TextEncoder().encode(line + "\r"));
  }

  cancel() {
    this.bridge.terminal.write(this.termId, new Uint8Array([0x03])); // Ctrl-C
  }

  resize() {
    if (!this._opened) return;
    this.fit.fit();
    const d = this.fit.proposeDimensions();
    if (d && d.rows > 0 && d.cols > 0) this.bridge.terminal.resize(this.termId, d.rows, d.cols);
  }

  dispose() {
    this._unsubs.forEach((u) => u());
    this._unsubs = [];
    try { this.bridge.terminal.close(this.termId); } catch {}
    this.term.dispose();
  }
}
