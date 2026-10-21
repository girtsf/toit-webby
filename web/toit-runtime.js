// In-browser Toit toolchain: runs the wasm-compiled `toit.compile` and `toit`
// (VM) binaries to turn source into a device-installable image, and to build a
// full flashable firmware image. Each high-level op instantiates a fresh module
// so emscripten global state never leaks between runs.
//
// Layout expected under ./wasm/ :
//   toit.compile.js/.wasm/.data   (compiler; single-threaded)
//   toit.js/.wasm/.data           (full CLI/VM; single-threaded too)
// The SDK core library is baked into each .data (preloaded at /sdk/lib/toit/lib).

import { appUrl, fetchBytes } from "./fetch-progress.js";

// `fn(label, loaded, total)` is called while wasm binaries download.
let progressFn = null;
export function onProgress(fn) { progressFn = fn; }

// `fn(label, { size, touched })` is called after each toolchain run with the
// instance's wasm memory size and an estimate of how much of it was used.
let memoryFn = null;
export function onMemory(fn) { memoryFn = fn; }

const LABELS = { "toit.compile": "compiler", "toit": "Toit VM" };
// The .wasm and .data of each binary, downloaded once and kept in memory.
const binaries = new Map();
function loadBinaries(name) {
  if (!binaries.has(name)) {
    const files = [`wasm/${name}.wasm`, `wasm/${name}.data`];
    const loaded = [0, 0], totals = [null, null];
    const report = () => progressFn?.(LABELS[name], loaded[0] + loaded[1],
      totals.includes(null) ? null : totals[0] + totals[1]);
    const p = Promise.all(files.map((f, i) => fetchBytes(f, (l, t) => {
      loaded[i] = l; totals[i] = t; report();
    }))).then(([wasm, data]) => ({ wasm, data }));
    p.catch(() => binaries.delete(name));
    binaries.set(name, p);
  }
  return binaries.get(name);
}

// Runs tool invocations (`steps`, a list of argument lists, in order) on one
// fresh module instance inside a dedicated worker; the steps share the
// instance's memory and MEMFS. `files` maps MEMFS path -> Uint8Array (inputs).
// `outputs` lists paths to read back after the last step.
// Returns { rc, stdout, stderr, out: {path: Uint8Array}, failed?: args }.
// Emscripten never tears an instance down (EXIT_RUNTIME=0) and something keeps
// each one (its wasm memory is hundreds of MB) alive, so the worker is
// terminated afterwards, which reliably frees everything. It also keeps the
// page responsive while the tool runs.
async function runTool(name, steps, { files = {}, outputs = [], execPath } = {}) {
  const { wasm, data } = await loadBinaries(name);
  const worker = newModuleWorker(appUrl("tool-worker.js"));
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.error) return reject(new Error(e.data.error));
        memoryFn?.(LABELS[name], e.data.memory);
        resolve(e.data);
      };
      worker.onerror = (e) => reject(new Error("tool worker: " + (e.message || "failed to start")));
      worker.postMessage({ url: appUrl(`wasm/${name}.js`), steps, files, outputs, execPath, wasm, data });
    });
  } finally {
    worker.terminate();
  }
}

// Workers must be same-origin with the page; when a device serves the page
// (device/webby.toit), start the app's worker through a blob that imports it.
function newModuleWorker(url) {
  if (new URL(url).origin === location.origin) return new Worker(url, { type: "module" });
  const shim = URL.createObjectURL(new Blob([`import ${JSON.stringify(url)};`], { type: "text/javascript" }));
  return new Worker(shim, { type: "module" });
}

const COMPILE_EXE = "/sdk/lib/toit/bin/toit.compile";
const VM_EXE = "/sdk/lib/toit/bin/toit.run";

// Compile Toit source text to a snapshot.
export async function compile(source) {
  const enc = new TextEncoder();
  const r = await runTool("toit.compile",
    [["-w", "/work/out.snapshot", "/work/main.toit"]],
    { files: { "/work/main.toit": enc.encode(source) }, outputs: ["/work/out.snapshot"], execPath: COMPILE_EXE });
  if (r.rc !== 0) throw new Error("compile failed:\n" + (r.stderr || r.stdout));
  return r.out["/work/out.snapshot"];
}

// Convert a snapshot to an installable device image (32-bit ESP32 family).
export async function snapshotToImage(snapshot, { wordSize = 4 } = {}) {
  const r = await runTool("toit",
    [["tool", "snapshot-to-image", "--format=binary", "-m" + (wordSize * 8),
      "--output", "/work/out.image", "/work/in.snapshot"]],
    { files: { "/work/in.snapshot": snapshot }, outputs: ["/work/out.image"], execPath: VM_EXE });
  if (r.rc !== 0) throw new Error("snapshot-to-image failed:\n" + (r.stderr || r.stdout));
  return r.out["/work/out.image"];
}

// Decodes a base64 system message from a device (e.g. the stack trace of an
// uncaught exception), like `jag decode`. If one of `snapshots` is the program
// that sent it, the trace gets method names and source positions. Runs
// assets/decode.snapshot (see decoder/decode.toit): the SDK's `toit decode`
// needs host pipes, which the wasm VM lacks.
let decoderSnapshot = null;
export async function decodeSystemMessage(message, snapshots = []) {
  decoderSnapshot ??= fetchBytes("assets/decode.snapshot").catch((e) => { decoderSnapshot = null; throw e; });
  const files = { "/work/decode.snapshot": await decoderSnapshot };
  snapshots.forEach((s, i) => { files[`/work/p${i}.snapshot`] = s; });
  const r = await runTool("toit",
    [["/work/decode.snapshot", message, ...snapshots.map((_, i) => `/work/p${i}.snapshot`)]],
    { files, execPath: VM_EXE });
  if (r.rc !== 0) throw new Error("decode failed:\n" + (r.stderr || r.stdout));
  return r.stdout;
}

// One-shot: Toit source -> installable image.
export async function buildImage(source) {
  return snapshotToImage(await compile(source));
}

// Drops the debug ELF (~25 of the envelope's ~27 MB) from an envelope (an ar
// archive). Only `firmware extract --format=elf` reads it; leaving it out
// keeps every firmware step from copying it around.
export function slimEnvelope(envelope) {
  const dec = new TextDecoder();
  const parts = [envelope.subarray(0, 8)];  // "!<arch>\n"
  let pos = 8;
  while (pos < envelope.length) {
    const header = envelope.subarray(pos, pos + 60);
    const name = dec.decode(header.subarray(0, 16)).trim().replace(/\/$/, "");
    const size = parseInt(dec.decode(header.subarray(48, 58)), 10);
    const end = pos + 60 + size + (size & 1);
    if (name !== "$firmware.elf") parts.push(envelope.subarray(pos, end));
    pos = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Build a complete flashable firmware image (bootloader+partitions+app+config)
// from a firmware envelope, with Jaguar + the UART endpoint baked in.
// Mirrors `jag flash` done entirely in wasm. Returns the 0x0 flash blob.
// `partitions` optionally overrides the envelope's partition table (CSV bytes).
// `webbyUrl` is the app's URL, for Jaguar* (its bootstrap page and CORS).
export async function buildFlashImage(envelope, { name, id, chip = "esp32s3",
    wifiSsid = "", wifiPassword = "", uartBaud = 921600, jaguarSnapshot, partitions = null,
    webbyUrl = null } = {}) {
  const enc = new TextEncoder();
  const jagCfg = enc.encode(JSON.stringify({ id, name, chip, endpointUart: { baud: uartBaud },
    ...(webbyUrl ? { webby: { url: webbyUrl } } : {}) }));
  const wifiCfg = enc.encode(JSON.stringify({ wifi: { "wifi.ssid": wifiSsid, "wifi.password": wifiPassword } }));

  // All steps run on one VM instance; intermediate files stay in its MEMFS.
  const r = await runTool("toit", [
    ["tool", "assets", "-e", "/work/assets.bin", "create"],
    ["tool", "assets", "-e", "/work/assets.bin", "add", "--format=tison", "config", "/work/jagcfg.json"],
    ["tool", "firmware", "-e", "/work/envelope", "container", "install", "-o", "/work/e2",
     "--assets", "/work/assets.bin", "--trigger=boot", "--critical", "jaguar", "/work/jaguar.snapshot"],
    ["tool", "firmware", "-e", "/work/e2", "property", "set", "uuid", id],
    ["tool", "firmware", "-e", "/work/e2", "extract", "--format=image", "-o", "/work/flash.bin", "--config", "/work/wifi.json",
     ...(partitions ? ["--partitions", "/work/partitions.csv"] : [])],
  ], {
    files: {
      "/work/jagcfg.json": jagCfg,
      "/work/wifi.json": wifiCfg,
      "/work/envelope": slimEnvelope(envelope),
      "/work/jaguar.snapshot": jaguarSnapshot,
      ...(partitions ? { "/work/partitions.csv": partitions } : {}),
    },
    outputs: ["/work/flash.bin"],
    execPath: VM_EXE,
  });
  if (r.rc !== 0) throw new Error("firmware step failed (" + r.failed.join(" ") + "):\n" + r.stderr + r.stdout);
  return r.out["/work/flash.bin"];
}
