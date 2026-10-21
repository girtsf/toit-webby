# Multi-chip support and envelope management

## Done
- Chip detected on connect (esptool-js, `detectChip` in `web/web-serial.js`);
  chip, features, flash size and MAC shown in the UI.
- All ESP32 envelopes of the pinned SDK are vendored by `tools/fetch-assets.sh`
  (~30 x ~11 MB) and listed in `assets/envelopes.json`; the UI offers the ones
  matching the detected chip, defaulting to the plain `<chip>` envelope.
- Firmware is fitted to the detected flash (`flasher/flash-parts.toit`, run
  in wasm): the rest of the flash becomes a `data` partition (type 0x41, like
  the `-16mb` envelopes; same table byte-for-byte) and the bootloader is
  stamped with the size (as the SDK does when a table outgrows the envelope),
  capped at 16 MB. Like `jag flash`, only bootloader, partition table, otadata
  and app are written; other partitions keep their old contents. Firmware
  needing more flash than detected is refused. Verified on a 16 MB ESP32-S3:
  boots, Wi-Fi works, `storage.Region.open --partition "data"` is 12 MB and
  writable.

## Remaining
- Only tested on ESP32-S3. esp32p4 has no envelope in this SDK version.
- Suggest an envelope from features (embedded PSRAM -> `-spiram*`).
- SDK version coupling: envelope, `jaguar.snapshot` and `web/wasm/` must match
  (pinned together in `versions.env`); not surfaced/enforced in the app.
- Envelope source: GitHub release assets send no CORS headers, hence
  vendoring same-origin. Pages site limit is 1 GB.
