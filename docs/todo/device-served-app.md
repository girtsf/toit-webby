# Serve the app from the device (Safari, phones)

Done (2026-10-20): the device's `/` (device/webby.toit) fetches the app's
index.html and writes it with a `<base>` at the app's URL; workers start via a
blob shim (toit-runtime.js). Verified with host-run Jaguar* in Chrome 155 and
Firefox 158 (`DEVICE_PAGE=1 tools/wifitest.mjs`), app on a separate origin
with the stamped import map.

## Still open
- Hardware: reflash an ESP32 with the new Jaguar* and test from Pages.
  Deploy Pages first: old Pages app + new device page fails (cross-origin
  worker).
- Safari / iOS: untested (wasm VM in an insecure context).
- `crypto.randomUUID()` needs a secure context; only used when flashing, which
  is unavailable on the device page anyway.
- The device page loads only what Wi-Fi needs (compiler, VM, decoder), but the
  USB section is still shown, disabled.
