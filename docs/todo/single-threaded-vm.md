# Single-threaded VM (drop cross-origin isolation)

## Why
The VM wasm (`web/wasm/toit.*`, built from `build/wasm-vm`) is compiled with
pthreads, so it needs `SharedArrayBuffer`, which needs cross-origin isolation
(COOP/COEP). That forces the `coi-serviceworker.js` shim on static hosts and
means every cross-origin resource must send CORS+CORP headers (this is what
broke the GitHub envelope fetch). The compiler (`toit.compile.*`) is already
single-threaded and needs none of this. If the VM were single-threaded too, we
could serve a plain static page with no service worker and no special headers.

## Approach
1. Build `toit` without `-pthread` (drop `-sPTHREAD_POOL_SIZE` etc.). It will
   link but fail at runtime where the Toit scheduler calls `pthread_create`
   (`third_party/toit/src/os_posix.cc`, `Thread::spawn`).
2. The hard part: the scheduler runs its process/event loop on a worker thread
   and blocks there. To run single-threaded we'd need that loop to run on the
   main thread cooperatively, or use Emscripten **Asyncify** so a blocking
   thread body can yield to the browser event loop.
3. Scope matters: we only run short, one-shot tool invocations
   (`snapshot-to-image`, `firmware extract`, `assets`), not a long-lived device
   runtime. A one-shot run may only need the main thread to do bounded work —
   worth probing how many threads the scheduler actually spawns for these.

## Findings (2026-10-20)
- A tool run uses 3 threads: main (blocked in `run_boot_program`), one
  `SchedulerThread`, and the `Timer` event source. With `OS::num_cores()`
  forced to 1 under `TOIT_WASM`, `PTHREAD_POOL_SIZE=2` works; 1 deadlocks.
- Each pthread worker costs only ~3-4 MB, so going fully single-threaded saves
  ~7 MB. The real payoff would be dropping SharedArrayBuffer/COOP/COEP.
- Shim sketch: under `TOIT_WASM`, implement `Thread`/`Mutex`/`ConditionVariable`
  (`os_posix.cc`) cooperatively, either on emscripten fibers (needs Asyncify:
  code size + speed cost) or by running the scheduler loop on the main thread
  and polling timers when idle.

## Open questions
- Does a tool run genuinely require concurrency, or can `Thread::spawn` run the
  body synchronously and return? (Try stubbing it and see what breaks.)
- Asyncify cost: code size + speed. Might be acceptable for a build tool.
- Could we instead do `snapshot-to-image` / firmware assembly in pure JS and
  drop the VM from the browser entirely? The image format + relocation is
  non-trivial (`third_party/toit/tools/image.toit`, `snapshot_to_image.toit`),
  so probably more work than the single-threaded build.

## Alternative that keeps isolation but reduces friction
Switch COEP from `require-corp` to `credentialless` (Chromium-only): keeps
`SharedArrayBuffer` but lets cross-origin *no-cors* fetches load without CORP.
Doesn't remove the service worker, and doesn't help Firefox/Safari.

## Verdict
Real porting effort with a genuine chance of not working. Only worth it if "zero
service worker / plain static hosting" becomes a hard requirement. Time-box it.
