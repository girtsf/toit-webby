# Multi-chip support and envelope management

## Why
Today the app is hard-wired to **esp32s3** and one SDK version
(`v2.0.0-alpha.199`), with the envelope vendored at
`web/assets/firmware-esp32s3.envelope.gz`. Toit/Jaguar support many ESP32
variants (esp32, esp32s2, esp32s3, esp32c3, esp32c6, esp32p4, …).

## Ideas
1. **Detect the chip.** esptool-js already reports the chip during flash ("Chip
   is ESP32-S3"). Detect first, then pick the matching envelope and word size.
   (Word size: all current ESP32 variants are 32-bit → `-m32` for
   `snapshot-to-image`; keep the knob though — `web/toit-runtime.js` already
   parameterizes `wordSize`.)
2. **Per-chip envelopes.** Vendor (or fetch same-origin) one envelope per chip:
   `firmware-<chip>.envelope.gz`. They're ~11 MB each; don't ship all of them
   unless needed. Could fetch on demand from a same-origin/CORS-friendly host.
3. **SDK version coupling.** The envelope, the Jaguar snapshot
   (`web/assets/jaguar.snapshot`), and the wasm toolchain
   (`web/wasm/`) must all be the **same** Toit SDK version. Document/enforce this
   — a mismatch means the device rejects the image (SDK version check) or odd
   failures. Consider stamping the version into the app and surfacing it.
4. **Envelope source.** GitHub release assets send no CORS/CORP headers, so they
   can't be fetched cross-origin under COEP (that's why we vendored). Options:
   vendor same-origin (current), or host envelopes somewhere that sends
   `ACAO: *` + `Cross-Origin-Resource-Policy: cross-origin`, or proxy via the
   local agent.

## Pointers
- Chip/envelope constants: top of `web/app.js` (`CHIP`, `SDK_VERSION`,
  `ENVELOPE_LOCAL`).
- Envelope URL pattern: `cmd/jag/commands/envelope.go#getFirmwareURL`
  (`.../firmware-<model>.envelope.gz`).
