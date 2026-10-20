// In-browser Toit toolchain: runs the wasm-compiled `toit.compile` and `toit`
// (VM) binaries to turn source into a device-installable image, and to build a
// full flashable firmware image. Each high-level op instantiates a fresh module
// so emscripten global state never leaks between runs.
//
// Layout expected under ./wasm/ :
//   toit.compile.js/.wasm/.data   (compiler; single-threaded)
//   toit.js/.wasm/.data           (full CLI/VM; pthreads -> needs COOP/COEP)
// The SDK core library is baked into each .data (preloaded at /sdk/lib/toit/lib).

const WASM_BASE = new URL("./wasm/", import.meta.url).href;

async function loadFactory(name) {
  const mod = await import(`${WASM_BASE}${name}.js`);
  return mod.default;
}

// Runs one tool invocation on a fresh module instance. `files` maps MEMFS path
// -> Uint8Array (inputs). `outputs` lists paths to read back afterwards.
// Returns { rc, stdout, stderr, out: {path: Uint8Array} }.
async function runTool(name, args, { files = {}, outputs = [], execPath } = {}) {
  const factory = await loadFactory(name);
  let stdout = "", stderr = "";
  const Module = {
    noInitialRun: true,
    locateFile: (p) => `${WASM_BASE}${p}`,
    print: (t) => { stdout += t + "\n"; },
    printErr: (t) => { stderr += t + "\n"; },
    preRun: [(m) => {
      m.ENV.TOIT_EXECUTABLE = execPath;
      try { m.FS.mkdir("/work"); } catch (_) {}
      for (const [path, data] of Object.entries(files)) {
        const slash = path.lastIndexOf("/");
        if (slash > 0) mkdirp(m.FS, path.slice(0, slash));
        m.FS.writeFile(path, data);
      }
    }],
  };
  const instance = await factory(Module);
  const rc = instance.callMain(args);
  const out = {};
  if (rc === 0) for (const p of outputs) out[p] = instance.FS.readFile(p);
  return { rc, stdout, stderr, out };
}

function mkdirp(FS, dir) {
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) { cur += "/" + p; try { FS.mkdir(cur); } catch (_) {} }
}

const COMPILE_EXE = "/sdk/lib/toit/bin/toit.compile";
const VM_EXE = "/sdk/lib/toit/bin/toit.run";

// Compile Toit source text to a snapshot.
export async function compile(source) {
  const enc = new TextEncoder();
  const r = await runTool("toit.compile",
    ["-w", "/work/out.snapshot", "/work/main.toit"],
    { files: { "/work/main.toit": enc.encode(source) }, outputs: ["/work/out.snapshot"], execPath: COMPILE_EXE });
  if (r.rc !== 0) throw new Error("compile failed:\n" + (r.stderr || r.stdout));
  return r.out["/work/out.snapshot"];
}

// Convert a snapshot to an installable device image (32-bit ESP32 family).
export async function snapshotToImage(snapshot, { wordSize = 4 } = {}) {
  const r = await runTool("toit",
    ["tool", "snapshot-to-image", "--format=binary", "-m" + (wordSize * 8),
     "--output", "/work/out.image", "/work/in.snapshot"],
    { files: { "/work/in.snapshot": snapshot }, outputs: ["/work/out.image"], execPath: VM_EXE });
  if (r.rc !== 0) throw new Error("snapshot-to-image failed:\n" + (r.stderr || r.stdout));
  return r.out["/work/out.image"];
}

// One-shot: Toit source -> installable image.
export async function buildImage(source) {
  return snapshotToImage(await compile(source));
}

// Build a complete flashable firmware image (bootloader+partitions+app+config)
// from a firmware envelope, with Jaguar + the UART endpoint baked in.
// Mirrors `jag flash` done entirely in wasm. Returns the 0x0 flash blob.
export async function buildFlashImage(envelope, { name, id, chip = "esp32s3",
    wifiSsid = "", wifiPassword = "", uartBaud = 921600, jaguarSnapshot } = {}) {
  const enc = new TextEncoder();
  const jagCfg = enc.encode(JSON.stringify({ id, name, chip, endpointUart: { baud: uartBaud } }));
  const wifiCfg = enc.encode(JSON.stringify({ wifi: { "wifi.ssid": wifiSsid, "wifi.password": wifiPassword } }));

  // Each step runs on a fresh VM instance (proven path); intermediate files are
  // carried forward in `fs`.
  const fs = {
    "/work/jagcfg.json": jagCfg,
    "/work/wifi.json": wifiCfg,
    "/work/envelope": envelope,
    "/work/jaguar.snapshot": jaguarSnapshot,
  };
  const step = async (args, inputs, outputs) => {
    const files = {}; for (const p of inputs) files[p] = fs[p];
    const r = await runTool("toit", args, { files, outputs, execPath: VM_EXE });
    if (r.rc !== 0) throw new Error("firmware step failed (" + args.join(" ") + "):\n" + r.stderr);
    Object.assign(fs, r.out);
  };
  await step(["tool", "assets", "-e", "/work/assets.bin", "create"], [], ["/work/assets.bin"]);
  await step(["tool", "assets", "-e", "/work/assets.bin", "add", "--format=tison", "config", "/work/jagcfg.json"],
    ["/work/assets.bin", "/work/jagcfg.json"], ["/work/assets.bin"]);
  await step(["tool", "firmware", "-e", "/work/envelope", "container", "install", "-o", "/work/e2",
       "--assets", "/work/assets.bin", "--trigger=boot", "--critical", "jaguar", "/work/jaguar.snapshot"],
    ["/work/envelope", "/work/assets.bin", "/work/jaguar.snapshot"], ["/work/e2"]);
  await step(["tool", "firmware", "-e", "/work/e2", "property", "set", "uuid", id],
    ["/work/e2"], ["/work/e2"]);
  await step(["tool", "firmware", "-e", "/work/e2", "extract", "--format=image", "-o", "/work/flash.bin", "--config", "/work/wifi.json"],
    ["/work/e2", "/work/wifi.json"], ["/work/flash.bin"]);
  return fs["/work/flash.bin"];
}
