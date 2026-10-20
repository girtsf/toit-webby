// Runs a browser-targeted wasm toit binary under node, for validation.
// Usage: node node-run.mjs <toit.js|toit.compile.js> <args...>
// The .data (preloaded SDK lib) and .wasm are read from next to the module.
// Host paths must be absolute; they are accessible under /host.
import path from "node:path";
import fs from "node:fs";

const [modPath, ...args] = process.argv.slice(2);
const base = path.resolve(modPath).replace(/\.js$/, "");
const dataBuf = fs.readFileSync(base + ".data");
const wasmBuf = fs.readFileSync(base + ".wasm");

const { default: createModule } = await import(path.resolve(modPath));
const mod = await createModule({
  noInitialRun: true,
  instantiateWasm: (info, receive) => {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmBuf), info);
    receive(inst);
    return inst.exports;
  },
  locateFile: (p) => path.join(path.dirname(path.resolve(modPath)), p),
  getPreloadedPackage: (name, size) =>
    dataBuf.buffer.slice(dataBuf.byteOffset, dataBuf.byteOffset + dataBuf.byteLength),
  preRun: [(m) => {
    m.ENV.TOIT_EXECUTABLE = process.env.TOIT_EXECUTABLE ?? "/sdk/lib/toit/bin/toit.compile";
    m.FS.mkdir("/host");
    m.FS.mount(m.NODEFS, { root: "/" }, "/host");
    m.FS.chdir("/host" + process.cwd());
  }],
});
const rc = mod.callMain(args);
process.exit(rc);
