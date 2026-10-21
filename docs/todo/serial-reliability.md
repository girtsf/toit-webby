# Serial reliability hardening

## Context
Over real Web Serial the run path is fast and reliable (~2.3 s, reproduced
repeatedly). But a few edge cases surfaced during bring-up that are worth
smoothing. Protocol details and the hard-won quirks are in the project memory
(`toit-webby-browser-constraints`) and `web/jaguar-uart.js`.

## Things to improve
1. **Post-flash reset portability.** esptool-js's `hard_reset` didn't reset the
   CP210x board here, so `web/web-serial.js#flashParts` does an explicit EN pulse
   via `port.setSignals` afterward. Verify this on other bridges (CH340, FTDI,
   native USB-JTAG on some ESP32-S3/C3 boards where DTR/RTS semantics differ).
   Provide a clear "if it didn't boot, press reset / replug" path.
2. **Sync robustness after a reset.** Sync can be briefly flaky right after a
   board reboots (boot timing). `run()` already self-syncs and retries the whole
   command; consider surfacing a friendlier "waiting for device…" state.
3. **"Lone command after sync" drop.** The very first command after sync can be
   dropped by the device. Current client avoids this by having `run()` sync then
   immediately stream, and by making `identify` best-effort. If we add more
   interactive commands (list/ping/uninstall), give them the same single-shot +
   re-sync treatment (see container-management.md).
4. **node-serialport harness is slow.** `tools/serial-run.mjs` streams ~2 s/chunk
   due to node-serialport read latency — a harness artifact, NOT the browser.
   Don't "fix" the browser based on node numbers. If we want a fast node harness
   (e.g. for CI), investigate a lower-latency serial binding or chunk pipelining.
5. **Progress + cancel.** Stream a visible progress bar for run/flash and allow
   cancel mid-transfer (currently fire-and-wait).

## Pointers
- Client: `web/jaguar-uart.js` (`_doSync`, `_request`, `_sendStreaming`,
  `_streamChunked`, `Demux`).
- Transport + flashing + reset: `web/web-serial.js`.
