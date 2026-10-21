# Run/flash over Wi-Fi (HTTP transport)

**Update (2026-10-20): done** for Chromium via Jaguar\* (CORS for the app's origin) + Chrome's Local Network Access (exempts `*.local`/private IPs from mixed-content blocking). See the README's "Wi-Fi: Jaguar\*" section and `web/jaguar-http.js`.

## Why
Today everything goes over USB (serial). The device also exposes the full Jaguar
API over HTTP once it's on Wi-Fi, so in principle you could push code without a
cable. The app was built serial-first precisely because the browser can't reach
the device's HTTP endpoint directly (see below), but this is the natural
extension and the client was structured to allow it.

## The blocker
`JaguarUart` is transport-agnostic, but the HTTP path isn't a drop-in because:
- The device serves plain `http://<ip>:9000` with **no CORS headers**, so a page
  (especially an HTTPS/Pages one) can't `fetch` it — mixed content + CORS.
- The HTTP API also expects specific headers (device id, SDK version, CRC32) and
  a container *image* body (same bytes we already build in-browser).

## Options
1. **Add CORS to the device.** We control Jaguar — add
   `Access-Control-Allow-Origin` (+ preflight handling) to its HTTP server
   (`third_party/jaguar/src/network.toit`, the `serve-incoming-requests`
   handler). Then a page served over **http** (not https) could talk to it
   directly. Still blocked from an HTTPS origin by mixed content.
2. **Local proxy/agent** (see `firefox-safari-bridge.md`) forwards page → device
   HTTP. Works from any origin.
3. **Run over serial, let the device reconnect Wi-Fi** — current design; keep as
   default.

## What's already reusable
- Image build (compile → `snapshot-to-image`) is identical regardless of
  transport.
- The HTTP request shapes are in `third_party/jaguar/cmd/jag/commands/device_network.go`
  (headers `X-Jaguar-Device-ID`, `X-Jaguar-SDK-Version`, `X-Jaguar-CRC32`;
  `PUT /run` / `PUT /install` with the image body).

## Verdict
Mostly a CORS + hosting-model problem, not a protocol problem. Cleanest via the
local agent; a device-side CORS change unlocks the http-origin case.
