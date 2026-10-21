# Building the Toit wasm toolchain

`tools/build-wasm.sh` automates everything below (clones toit at
`TOIT_VERSION` from `versions.env`, applies the patch, downloads a native SDK
unless `HOST_TOIT` is set, builds both targets, fills `web/wasm/` and packs
`build/toit-wasm.tar.gz`). Run it with emsdk activated:
```
source third_party/emsdk/emsdk_env.sh
HOST_TOIT=~/.cache/jaguar/v1.72.0/sdk/bin/toit tools/build-wasm.sh
```
To publish: bump `WASM_TAG` in `versions.env`, push, run the "Build wasm
release" workflow (or `gh release create $WASM_TAG build/toit-wasm.tar.gz`).

Manual steps:

## Prerequisites
- A native Toit SDK (used to bootstrap boot snapshots). Easiest: `jag setup`,
  which installs it under `~/.cache/jaguar/<ver>/sdk`.
- emscripten (emsdk), cmake, ninja/make.
- Toit sources at `third_party/toit` checked out at the SDK's tag
  (e.g. `v2.0.0-alpha.199`), with submodules:
  `git submodule update --init --depth 1 third_party/esp-idf`
  then inside it `components/mbedtls/mbedtls`.

## Apply the wasm port patch
```
cd third_party/toit
git apply ../../patches/toit-wasm.patch
```
The patch makes the C++ build for `__EMSCRIPTEN__`: 32-bit memory model, a
`TOIT_WASM` define, no-fork compiler, no stacktrace/execinfo, a stubbed
executable-path (`TOIT_EXECUTABLE` env), and it excludes the Linux
hardware/socket/subprocess drivers from the VM link (their primitive tables are
weak symbols, so leaving them out is fine for a host-side tool).

Built without `-pthread`, the patch defines `TOIT_NO_THREADS`: the scheduler
runs processes on the main thread (no `SchedulerThread`, no preemption ticks;
a process runs until it blocks or yields), the timer event source has no thread
and is polled by that loop (busy-waiting until the next timer when nothing is
ready), and `Mutex` tracks its own lock state since emscripten's pthread stubs
are no-ops. Spawning a thread or waiting on a condition variable is FATAL. So
neither binary needs `SharedArrayBuffer` or cross-origin isolation.

## Compiler (single-threaded)
```
mkdir -p build/wasm && cd build/wasm
emcmake cmake ../../third_party/toit -DCMAKE_BUILD_TYPE=Release \
  -DHOST_TOIT=$HOME/.cache/jaguar/<ver>/sdk/bin/toit -DTOIT_GIT_VERSION=<ver>
emcmake cmake . -DCMAKE_EXE_LINKER_FLAGS="-sMODULARIZE=1 -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ENV -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=16MB \
  --preload-file ../../third_party/toit/lib@/sdk/lib/toit/lib"
emmake make -j toit.compile
```

## VM / full `toit` (single-threaded too)
```
mkdir -p build/wasm-vm/generated && cd build/wasm-vm
emcmake cmake ../../third_party/toit -DCMAKE_BUILD_TYPE=Release \
  -DHOST_TOIT=$HOME/.cache/jaguar/<ver>/sdk/bin/toit -DTOIT_GIT_VERSION=<ver>
emcmake cmake . -DCMAKE_EXE_LINKER_FLAGS="-sMODULARIZE=1 -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ENV -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=64MB -sSTACK_SIZE=8MB \
  --preload-file ../../third_party/toit/lib@/sdk/lib/toit/lib"
emmake make -j toit
```

Copy outputs into `web/wasm/`:
```
cp build/wasm/sdk/lib/toit/bin/toit.compile.{js,wasm,data} web/wasm/
cp build/wasm-vm/sdk/bin/toit.{js,wasm,data} web/wasm/
```

## Validate under node (no browser)
```
node tools/toitc-node.mjs hello.toit out.snapshot     # compiler path
node tools/browsertest.mjs http://localhost:8000/selftest.html  # full, in headless Chrome
```
