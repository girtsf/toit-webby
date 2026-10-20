// Web Serial glue: a JaguarUart transport, plus esptool-js flashing.
// Holds a single navigator.serial port and lends it to either esptool (for
// flashing) or the Jaguar UART client (for running), reopening at the needed
// baud rate between phases.

import { ESPLoader, Transport } from "./vendor/esptool-js.js";

export function isSupported() { return "serial" in navigator; }

// Ask the user to pick a serial port (must be called from a user gesture).
export async function requestPort() {
  return navigator.serial.requestPort();
}

// Flash a full firmware image to address 0x0 using esptool-js.
// `onProgress(fraction, label)` and `onLog(text)` are optional.
export async function flashImage(port, flashBin, { onProgress, onLog } = {}) {
  const transport = new Transport(port, false);
  const esp = new ESPLoader({
    transport,
    baudrate: 921600,
    romBaudrate: 115200,
    terminal: onLog ? { clean() {}, writeLine: (d) => onLog(d), write: (d) => onLog(d) } : undefined,
  });
  try {
    await esp.main();                      // detect chip, sync
    const binStr = u8ToBinaryString(flashBin);
    await esp.writeFlash({
      fileArray: [{ data: binStr, address: 0x0 }],
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (idx, written, total) => { if (onProgress) onProgress(written / total, "writing"); },
    });
    try { await esp.after("hard_reset"); } catch (_) {}
  } finally {
    try { await transport.disconnect(); } catch (_) {}
  }
  // esptool-js's hard_reset doesn't reliably reset every USB-UART bridge (e.g.
  // some CP210x boards stay in the ROM bootloader), which leaves the freshly
  // flashed firmware not running. Do an explicit EN pulse over Web Serial.
  try {
    await port.open({ baudRate: 115200 });
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });  // EN low
    await new Promise((r) => setTimeout(r, 120));
    await port.setSignals({ dataTerminalReady: false, requestToSend: false }); // release -> run
    await new Promise((r) => setTimeout(r, 50));
    await port.close();
  } catch (_) { /* best effort; user can unplug/replug if needed */ }
}

function u8ToBinaryString(u8) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return s;
}

// A JaguarUart transport over an open Web Serial port.
export class WebSerialTransport {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this._cbs = [];
  }
  async open(baudRate) {
    await this.port.open({ baudRate, bufferSize: 4096 });
    this.writer = this.port.writable.getWriter();
    this._readLoop();
  }
  async _readLoop() {
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this._cbs.forEach((cb) => cb(value));
      }
    } catch (_) { /* closed */ }
  }
  onData(cb) { this._cbs.push(cb); }
  async write(bytes) { await this.writer.write(bytes); }
  async setSignals(sig) { try { await this.port.setSignals(sig); } catch (_) {} }
  async close() {
    try { await this.reader?.cancel(); } catch (_) {}
    try { this.reader?.releaseLock(); } catch (_) {}
    try { await this.writer?.close(); } catch (_) {}
    try { this.writer?.releaseLock(); } catch (_) {}
    try { await this.port.close(); } catch (_) {}
  }
}
