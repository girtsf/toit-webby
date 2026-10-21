# Ideas to explore

Backlog for Toit Webby. Each file is one idea: why, a sketch of the approach,
open questions, and pointers into the code. Not committed work — a menu.

Current state (for context): compile + firmware-build + run all work in-browser
over Web Serial on a real ESP32-S3 (Chromium-family browsers), and over Wi-Fi
with Jaguar\* (run, install, containers, live output, decoded stack traces).
The toolchain is single-threaded wasm, so the app is plain static files (no
COOP/COEP); each Pages deploy is smoke-tested in CI. See `../../README.md`.

| Idea | One-liner |
|------|-----------|
| [firefox-safari-bridge](firefox-safari-bridge.md) | Local WebSocket agent so non-Chromium browsers work |
| [lan-discovery](lan-discovery.md) | Find already-networked Toit devices (the hard browser limit) |
| [network-run-transport](network-run-transport.md) | Push code over Wi-Fi/HTTP, not just USB |
| [serial-reliability](serial-reliability.md) | Harden sync/stream/reset edge cases |
| [container-management](container-management.md) | Install/list/uninstall persistent containers in the UI |
| [faster-flash](faster-flash.md) | Make flashing quicker and less destructive |
| [multi-chip-and-envelopes](multi-chip-and-envelopes.md) | Remaining bits of multi-chip support (envelope suggestions, version checks) |
| [editor-language-support](editor-language-support.md) | Real Toit language smarts (LSP, autocomplete, errors) |
| [multi-file-projects](multi-file-projects.md) | More than a single source file; packages |
