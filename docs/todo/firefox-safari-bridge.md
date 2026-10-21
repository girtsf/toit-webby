# Firefox / Safari support via a local bridge

## Why
Firefox and Safari don't implement the Web Serial API (Mozilla/Apple declined it
on security grounds), and there's no flag or extension API for it. So the device
half of the app can't run there as a pure page. The in-browser compile/VM parts
DO work in Firefox (plain single-threaded WebAssembly).

## Approach
Move serial I/O out of the page into a tiny local agent:
- A small Node/Go/Python program owns `/dev/ttyUSB*` and exposes it over
  `ws://localhost:<port>` (and/or a small HTTP API).
- The page connects via WebSocket (works in every browser) and the agent does
  the actual reads/writes.

Two pieces to port:
1. **Run path** — easy. `web/jaguar-uart.js` is already transport-agnostic
   (`JaguarUart` takes a transport with `write(bytes)` + `onData(cb)`). Add a
   `WebSocketTransport` next to `WebSerialTransport`; the agent relays raw bytes
   both directions. No protocol changes. (The node harness `tools/serial-run.mjs`
   already proves the client works over a non-Web-Serial transport.)
2. **Flash path** — simplest to let the agent run flashing itself (it has the
   port; could even shell out to esptool or embed esptool logic) rather than
   proxying esptool-js's byte stream.

## Tradeoff
Breaks the "zero-install page on GitHub Pages" property — the user downloads and
runs the agent once. This is exactly how Arduino's web tools and some ESP
flashers support Firefox/Safari. The page can detect `navigator.serial` and show
the agent path only when needed.

## Open questions
- One agent for both flash and run, or keep flash native + run over WS?
- Security: bind to 127.0.0.1 only; consider a simple origin/token check so
  arbitrary pages can't drive the user's serial ports.
- Packaging the agent (single binary? `npx`? OS install?).
