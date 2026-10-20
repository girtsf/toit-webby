// Validates the browser toit.compile build under node using MEMFS only
// (the same code path the browser uses: no host filesystem).
// Usage: node toitc-node.mjs <input.toit> <output.snapshot>
import fs from "node:fs";
import path from "node:path";

const MOD = "/home/girts/d/toit-webby/build/wasm/sdk/lib/toit/bin/toit.compile.js";
const [inPath, outPath] = process.argv.slice(2);

const base = MOD.replace(/\.js$/, "");
const dataBuf = fs.readFileSync(base + ".data");
const wasmBuf = fs.readFileSync(base + ".wasm");
const src = fs.readFileSync(inPath);

const { default: createModule } = await import(MOD);
let out = null;
const mod = await createModule({
  noInitialRun: true,
  instantiateWasm: (info, receive) => {
    receive(new WebAssembly.Instance(new WebAssembly.Module(wasmBuf), info));
  },
  locateFile: (p) => path.join(path.dirname(MOD), p),
  getPreloadedPackage: () =>
    dataBuf.buffer.slice(dataBuf.byteOffset, dataBuf.byteOffset + dataBuf.byteLength),
  preRun: [(m) => {
    m.ENV.TOIT_EXECUTABLE = "/sdk/lib/toit/bin/toit.compile";
    m.FS.mkdir("/work");
    m.FS.writeFile("/work/main.toit", src);
  }],
});
const rc = mod.callMain(["-w", "/work/out.snapshot", "/work/main.toit"]);
if (rc === 0) {
  out = mod.FS.readFile("/work/out.snapshot");
  fs.writeFileSync(outPath, out);
}
console.error("rc=" + rc + (out ? " bytes=" + out.length : ""));
process.exit(rc);
