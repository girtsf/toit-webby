# Serve the app from the device (Safari, phones)

## Why
The app talks to Wi-Fi devices from its HTTPS origin, which relies on Chrome's
Local Network Access (LNA). Safari has no LNA and blocks HTTPS -> http://local
requests, and Firefox's LNA is still untested. If the app ran on the device's
own `http://<name>.local:9000/` origin, every device call would be same-origin:
no LNA, no mixed content, no CORS.

This used to be blocked: an `http://` origin isn't a secure context, so no
`SharedArrayBuffer`, so no pthreaded wasm VM. The VM is single-threaded now
(docs/BUILD.md), so the toolchain should work there too.

## Approach
The device's `/` page (device/webby.toit) currently redirects to the Pages app.
Instead it would serve a small HTML shell that loads the app's modules and wasm
from Pages (GitHub Pages sends `Access-Control-Allow-Origin: *`) and talks to
the device with relative URLs.

## Known gaps (unverified)
- No Web Serial on an insecure origin: Wi-Fi only (fine, that's the point).
- `crypto.randomUUID()` (app.js, new device ids) needs a secure context; only
  used when flashing, which needs USB anyway.
- Workers must be same-origin: `new Worker(<Pages URL>)` fails. Use a blob URL
  that `import()`s the Pages module.
- The import map / `appUrl()` resolve against the page; the shell needs a base
  pointing at Pages (and the stamped import map, or a fetch of index.html).
- Pages assets are ~330 MB of envelopes, but Wi-Fi mode only needs the compiler,
  VM and decoder (~10 MB).

## Open questions
- Does Safari (iOS too) run the wasm VM fine in an insecure context?
- Is a device-served shell maintainable next to the Pages app, or should the
  Pages app itself detect "loaded inside the device shell" and switch transport?
