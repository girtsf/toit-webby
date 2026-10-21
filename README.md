# Toit Webby

**WORK IN PROGRESS**: most of this was written by robots and not fact checked.

Flash [Jaguar](https://github.com/toitlang/jaguar) onto an ESP32 and compile &
run [Toit](https://toitlang.org) programs on it — entirely from a web page, over
USB (Web Serial) or Wi-Fi. No native toolchain, no server. Hostable on GitHub
Pages.

The Toit **compiler** and **VM** are compiled to WebAssembly and run in the
browser, so compiling source to an installable device image happens client-side.
Talking to the device uses Jaguar's UART protocol over Web Serial, so nothing
needs the network — code is pushed down the same USB cable.

## Status (prototype)

**Validated end-to-end in a real browser, on a real ESP32-S3:**
- In-browser `toit.compile`, `snapshot-to-image`, and full firmware-image build
  (bootloader+partitions+app+config) — all in single-threaded WebAssembly, so
  any static host works: no cross-origin isolation needed (`web/selftest.html`).
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

**Over Wi-Fi (Jaguar\*), validated on the same ESP32-S3:** flash with Wi-Fi
credentials, the page watches the serial output until the device reports its
address, then offers `http://<name>.local:9000/`. From there: compile & run
(~4.5 s round trip), install/uninstall named containers, stop running ones, see
`print`/`log` output live, and get stack traces of crashing programs decoded
in the browser.

**Not done (prototype scope):** multi-file projects, packages, discovery of
devices you don't know the name of (browsers can't browse mDNS).

## Wi-Fi: Jaguar\*

The page flashes **Jaguar\***: upstream Jaguar (version pinned in `versions.env`) plus
`patches/jaguar-webby.patch` and `device/webby.toit`, built by
`tools/build-snapshots.sh`. On top of Jaguar it adds:
- an mDNS responder, so the device answers to `<name>.local`;
- CORS headers for the page's own origin (baked into the firmware at flash
  time), so the page can call Jaguar's HTTP API;
- [toit-logd](https://github.com/girtsf/toit-logd), embedded and installed
  before any container starts, so `print`, `log` and stack traces of every
  container are buffered and served on `GET /logd` (logd's own monitor works
  against `:9000` too);
- `/webby/containers` (installed + running) and `/webby/stop`;
- at `/`, a page that sends the browser to the app with `#device=<host>`.

How the HTTPS page reaches an HTTP device: Chrome's [Local Network
Access](https://developer.chrome.com/blog/local-network-access) exempts
`*.local` names and private IPs from mixed-content blocking, behind a one-time
"allow access to devices on your local network" prompt. The page stays on HTTPS
on purpose: the device's `http://` origin is not a secure context, so no Web
Serial there. Hence the device's page only redirects.

Stack traces: logd captures the encoded system message; the page decodes it
with `assets/decode.snapshot` (`decoder/decode.toit`, built from the SDK's own
trace decoder) running on the wasm VM, using the snapshots it compiled this
session for symbols. (The SDK's `toit decode` needs host pipes, which the wasm
VM lacks.)

Without hardware, Jaguar\* also runs on the host (64-bit images, mDNS works
through avahi):

```
cd build/jaguar-webby   # after tools/build-snapshots.sh
cp ../../device/host_run.toit src/
../../third_party/toit-sdk-*/bin/toit run src/host_run.toit http://localhost:8777/
node ../../tools/wifitest.mjs http://localhost:8777/ webby-host.local:9123
```

Caveats: Chromium only (Local Network Access, Web Serial). The device HTTP API
has no authentication beyond CORS for one origin (like Jaguar itself: trusted
networks only). Opening/closing the USB port resets CP210x boards.

## Why serial first

Web Serial is what flashes the device in the first place, and it works without
any network. It is still the fallback when Wi-Fi isn't available.

## Run it

```
tools/build-snapshots.sh   # Jaguar* and the trace decoder (native Toit SDK)
tools/fetch-assets.sh      # envelopes, esptool-js, prebuilt wasm
                           # (ENVELOPES='^esp32s3$' to fetch just one, ~11 MB each)
cd web
python3 serve.py 8000      # static server with wasm MIME type, no caching
# open http://localhost:8000  in Chrome/Edge/Opera
```

1. **Connect over USB** — pick the ESP32's serial port. The chip type is
   detected (esptool) and the envelope dropdown lists the matching firmware.
2. **Flash Jaguar\*** — enter a device name (+ optional Wi-Fi), click Flash. The
   firmware is built in your browser and written over USB (~once per device).
   With Wi-Fi set, the page waits for the device to come online and links to
   `http://<name>.local:9000/`.
3. **Wi-Fi device** — connect by name (or open the device's page), pick an
   example or write code, then Compile & Run or Install; manage containers in
   the side panel.

Deploying to GitHub Pages: `.github/workflows/pages.yml` runs
`tools/fetch-assets.sh`, then `tools/stamp-urls.mjs` (an import map of
content-hashed URLs, so a page load never mixes cached old and new files under
Pages' 10-minute caching), and deploys `web/` as a Pages artifact (set Pages
source to "GitHub Actions"). No special headers are needed (`coi-serviceworker.js` only
retires the cross-origin isolation shim older versions installed).

Binaries are not in git. Upstream ones (all ESP32 envelopes, esptool-js) are
fetched from their releases at the versions pinned in `versions.env`; the
snapshots are built in CI by `tools/build-snapshots.sh`; the wasm toolchain is a release asset of this repo (`WASM_TAG`),
built by `.github/workflows/wasm-release.yml`.

## Building the wasm toolchain

`tools/build-wasm.sh` builds it into `web/wasm/` (details in `docs/BUILD.md`).
After a local build use `SKIP_WASM=1 tools/fetch-assets.sh` so the release
download doesn't overwrite it.

## Layout

- `web/` — the app (static; deployable as-is)
  - `toit-runtime.js` — runs the wasm compiler/VM (compile, image, firmware build)
  - `jaguar-uart.js` — Jaguar UART protocol (transport-agnostic)
  - `jaguar-http.js` — Jaguar\* HTTP client (run/install/containers, logd)
  - `examples.js` — example programs for the editor
  - `web-serial.js` — Web Serial transport + esptool-js flashing
  - `editor.js` — CodeMirror 6 + a small Toit highlighter
  - `wasm/` — `toit.compile` and `toit` built for the browser
- `device/` — Jaguar\* additions (`webby.toit`) and `host_run.toit`, which runs
  Jaguar\* on the host for testing without hardware
- `decoder/` — the in-browser stack-trace decoder
- `tools/` — build scripts and node harnesses used to validate on hardware
  (`hwtest.mjs`: flash + Wi-Fi end-to-end; `wifitest.mjs`: Wi-Fi flow against
  any Jaguar\*, e.g. host-run; `serial-run.mjs`, `browsertest.mjs`, ...)

## AI Disclosure

Robots wrote most of this.
