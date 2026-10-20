# LAN discovery of already-networked devices

## Why
The original ask included detecting devices already running Toit on the local
network. A Jaguar device broadcasts its identity over UDP (port 1990) and serves
HTTP on 9000. From a plain browser page this is impossible:
- Browsers can't send/receive UDP, can't do mDNS, can't scan TCP ports.
- Even if you knew the IP, a page on GitHub Pages (HTTPS) can't talk to the
  device's `http://<ip>:9000` — mixed content, and the device sends no CORS
  headers. (See `network-run-transport.md`.)

## Options
1. **Local helper (recommended if we do it).** The same agent idea as
   `firefox-safari-bridge.md` can do UDP/mDNS discovery natively and expose a
   `GET /devices` list to the page over WebSocket/HTTP+CORS. Clean, but needs
   the agent running.
2. **Modify the device side.** We control Jaguar/Toit, so we could add mDNS
   advertisement — but it still can't be *discovered* from a pure browser page
   (no mDNS in browsers), so this only helps if a helper/OS does the lookup.
3. **Manual IP entry.** Let the user type an IP. Only works if the page is
   served over plain HTTP (not HTTPS/Pages) to avoid mixed content, and the
   device would need CORS headers added (we control it — see
   `network-run-transport.md`).

## Pointers
- Device broadcast + HTTP endpoint: `third_party/jaguar/src/network.toit`
  (`IDENTIFY-PORT 1990`, `HTTP-PORT 9000`, `broadcast-identity`).
- jag's host-side discovery: `cmd/jag/commands/scan.go`.

## Verdict
Genuinely needs something outside the browser sandbox. Fold into the local-agent
work; not worth a standalone browser-only attempt (there's no way).
