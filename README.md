# Toit Webby

**WORK IN PROGRESS**: most of this was written by robots and not fact checked.

Flash [Jaguar](https://github.com/toitlang/jaguar) onto an ESP32 and compile &
run [Toit](https://toitlang.org) programs on it — entirely from a web page, over
USB (Web Serial). No native toolchain, no server. Hostable on GitHub Pages.

The Toit **compiler** and **VM** are compiled to WebAssembly and run in the
browser, so compiling source to an installable device image happens client-side.
Talking to the device uses Jaguar's UART protocol over Web Serial, so nothing
needs the network — code is pushed down the same USB cable.

## Status (prototype)

**Validated end-to-end in a real browser, on a real ESP32-S3:**
- In-browser `toit.compile`, `snapshot-to-image`, and full firmware-image build
  (bootloader+partitions+app+config) — all in WebAssembly, running in Chrome
  with cross-origin isolation (`web/selftest.html`).
- **Flash:** firmware built in-browser (4 MB) is written over Web Serial with
  esptool-js, and the device boots into Jaguar.
- **Run:** compile → image → stream over Web Serial with the Jaguar UART
  protocol (`web/jaguar-uart.js`); `run()` finishes in ~2.3 s and the program
  executes on the device (reproduced 3/3). Confirmed as one chain:
  browser-flashed firmware boots and then runs browser-compiled code.

Notes from bringing it up:
- esptool-js's post-flash `hard_reset` didn't reset the CP210x board here, so
  `flashImage` does an explicit EN pulse (`setSignals`) after flashing. If a
  board still doesn't come up after flashing, unplug/replug.
- esptool-js is vendored locally (`web/vendor/esptool-js.js`) because esm.sh
  can't resolve its dynamic stub-flasher import.
- A node test harness (`tools/serial-run.mjs`, over the `serialport` npm pkg)
  streams much slower than the browser (node-serialport read latency) — the
  browser's Web Serial I/O path doesn't have this. Use the browser for the
  real thing.

**Not done (prototype scope):** LAN discovery of already-networked devices (a
hard browser limit — see below), container-management UI, persistent install,
multi-file projects.

## Why serial-only

A page on GitHub Pages is HTTPS; a Jaguar device serves plain HTTP on :9000 with
no CORS headers, so a hosted page cannot talk to a networked device
(mixed-content + CORS). Browsers also can't do UDP/mDNS/port-scanning, so
discovering networked devices from a plain page is impossible. Web Serial sidesteps
all of it: flash and run over USB. The code is structured so an HTTP transport can
be added later (e.g. via a small local proxy).

## Run it

```
tools/fetch-assets.sh      # envelopes, jaguar.snapshot, esptool-js, prebuilt wasm
                           # (ENVELOPES='^esp32s3$' to fetch just one, ~11 MB each)
cd web
python3 serve.py 8000      # serves with COOP/COEP (needed for the VM's threads)
# open http://localhost:8000  in Chrome/Edge/Opera
```

1. **Connect over USB** — pick the ESP32's serial port. The chip type is
   detected (esptool) and the envelope dropdown lists the matching firmware.
2. **Flash Jaguar** — enter a device name (+ optional Wi-Fi), click Flash. The
   firmware is built in your browser and written over USB (~once per device).
3. **Compile & Run** — edit the Toit program and run it; output streams back.

Deploying to GitHub Pages: `.github/workflows/pages.yml` runs
`tools/fetch-assets.sh` and deploys `web/` as a Pages artifact (set Pages source
to "GitHub Actions"). `coi-serviceworker.js` adds the required COOP/COEP headers
on static hosts.

Binaries are not in git. Upstream ones (all ESP32 envelopes, `jaguar.snapshot`,
esptool-js) are fetched from their releases at the versions pinned in
`versions.env`; the wasm toolchain is a release asset of this repo (`WASM_TAG`),
built by `.github/workflows/wasm-release.yml`.

## Building the wasm toolchain

`tools/build-wasm.sh` builds it into `web/wasm/` (details in `docs/BUILD.md`).
After a local build use `SKIP_WASM=1 tools/fetch-assets.sh` so the release
download doesn't overwrite it.

## Layout

- `web/` — the app (static; deployable as-is)
  - `toit-runtime.js` — runs the wasm compiler/VM (compile, image, firmware build)
  - `jaguar-uart.js` — Jaguar UART protocol (transport-agnostic)
  - `web-serial.js` — Web Serial transport + esptool-js flashing
  - `editor.js` — CodeMirror 6 + a small Toit highlighter
  - `wasm/` — `toit.compile` and `toit` built for the browser
- `tools/` — node harnesses used to validate on hardware
  (`serial-run.mjs`, `toitc-node.mjs`, `browsertest.mjs`)

## AI Disclosure

Robots wrote most of this.
