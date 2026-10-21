// Runs emscripten tool invocations (see runTool in toit-runtime.js) on one
// module instance: `steps` are argument lists run in order with callMain,
// sharing the instance's memory and MEMFS. The owner terminates this worker
// afterwards, freeing the instance.

self.onmessage = async ({ data: { url, steps, files, outputs, execPath, wasm, data } }) => {
  var stderr = "";
  try {
    const factory = (await import(url)).default;
    const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
    let stdout = "";
    const instance = await factory({
      noInitialRun: true,
      // The glue ignores Module.wasmBinary, so hand it the bytes as a blob URL.
      locateFile: (p) => (p.endsWith(".wasm") ? wasmUrl : new URL(p, url).href),
      getPreloadedPackage: () => data.buffer,
      print: (t) => { stdout += t + "\n"; },
      printErr: (t) => { stderr += t + "\n"; },
      preRun: [(m) => {
        m.ENV.TOIT_EXECUTABLE = execPath;
        mkdirp(m.FS, "/work");
        for (const [path, bytes] of Object.entries(files)) {
          mkdirp(m.FS, path.slice(0, path.lastIndexOf("/")));
          m.FS.writeFile(path, bytes);
        }
      }],
    });
    for (const args of steps) {
      const rc = instance.callMain(args);
      if (rc !== 0) {
        self.postMessage({ rc, stdout, stderr, out: {}, failed: args, memory: memoryStats(instance.HEAPU8) });
        return;
      }
    }
    const out = {};
    for (const p of outputs) out[p] = instance.FS.readFile(p);
    self.postMessage({ rc: 0, stdout, stderr, out, memory: memoryStats(instance.HEAPU8) });
  } catch (e) {
    self.postMessage({ error: (e.stack || String(e)) + (stderr ? "\nstderr:\n" + stderr : "") });
  }
};

// Pages can't see real memory use, so estimate it: the browser only backs wasm
// pages once they are written, so count the (64 KB) pages holding any non-zero
// byte. `size` is the linear memory size, mostly an untouched reservation.
function memoryStats(heap) {
  const PAGE_WORDS = 65536 / 4;
  const words = new Int32Array(heap.buffer, 0, heap.byteLength >> 2);
  let touched = 0;
  for (let p = 0; p < words.length; p += PAGE_WORDS) {
    const end = Math.min(p + PAGE_WORDS, words.length);
    for (let i = p; i < end; i++) {
      if (words[i] !== 0) { touched++; break; }
    }
  }
  return { size: heap.byteLength, touched: touched * 65536 };
}

function mkdirp(FS, dir) {
  let cur = "";
  for (const p of dir.split("/").filter(Boolean)) {
    cur += "/" + p;
    try { FS.mkdir(cur); } catch (_) {}
  }
}
