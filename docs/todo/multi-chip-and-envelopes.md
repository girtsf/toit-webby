# Multi-chip support and envelope management

## Done
- Chip detected on connect (esptool-js, `detectChip` in `web/web-serial.js`);
  chip, features, flash size and MAC shown in the UI.
- All ESP32 envelopes of the pinned SDK are vendored by `tools/fetch-assets.sh`
  (~30 x ~11 MB) and listed in `assets/envelopes.json`; the UI offers the ones
  matching the detected chip, defaulting to the plain `<chip>` envelope.

## Remaining
- Only tested on ESP32-S3. esp32p4 has no envelope in this SDK version.
- Suggest an envelope from features (embedded PSRAM -> `-spiram*`, flash size).
- Refuse a flash image bigger than the detected flash (the `-16mb`/8/32 MB
  envelopes on a 4 MB chip); not checked today.
- SDK version coupling: envelope, `jaguar.snapshot` and `web/wasm/` must match
  (pinned together in `versions.env`); not surfaced/enforced in the app.
- Envelope source: GitHub release assets send no CORS headers, hence
  vendoring same-origin. Pages site limit is 1 GB.
