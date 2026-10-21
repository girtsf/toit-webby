# Container management UI

**Update (2026-10-20): done over Wi-Fi** (install/list/uninstall/stop in the side panel, `web/jaguar-http.js`). Over USB only install is wired up; list/uninstall over UART remain.

## Why
Right now the app only does ephemeral `run` (program runs until it exits). Jaguar
also supports **installing** named containers that persist across reboots, plus
listing and uninstalling them. The UART protocol already has all of this and the
client already implements most commands.

## What exists
`web/jaguar-uart.js` already has:
- `CMD.LIST` (3), `CMD.UNINSTALL` (4), `CMD.INSTALL` (6), `CMD.RUN` (7),
  `CMD.PING` (1), `CMD.IDENTIFY` (2).
- `install(name, image, defines)` is implemented (streams like run).
- `list`/`uninstall` are NOT yet wrapped — easy to add via `_request`:
  - list: `_request(CMD.LIST, [])` → ubjson-decode the registry entries.
  - uninstall: `_request(CMD.UNINSTALL, utf8(name))`.

## UI sketch
- A "Device" panel listing installed containers (name, id) from `list`.
- Per-container "uninstall" button.
- "Install" vs "Run" choice when sending code (install = persist + name it).
- `defines` support: `jag.wifi=false`, `jag.timeout`, `jag.interval` (periodic
  background containers) — see `JAG-*` defines in
  `third_party/jaguar/src/jaguar.toit` and `extractDefines` in
  `cmd/jag/commands/proxy_network.go`.

## Notes
- Reliability: list/uninstall are single request/response (no streaming), so give
  them the single-shot + re-sync-if-needed treatment (see serial-reliability.md).
- `list` returns UBJSON; the client's `ubjsonDecode` already handles the
  optimized `{#`/`$` forms used by identify.
