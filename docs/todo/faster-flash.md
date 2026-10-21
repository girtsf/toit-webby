# Faster / less destructive flashing

## Why
Flashing writes the pieces `toit tool firmware flash` would (bootloader,
partition table, otadata, app; ~1.7 MB, ~26 s on the ESP32-S3 here) over Web
Serial via esptool-js. It's a one-time-per-device step, but could be nicer.

## Ideas
1. **Higher baud.** esptool-js connects at romBaudrate 115200 then uses 921600.
   Try a higher flash baud (some CP210x/boards do 1.5M+). Measure; fall back on
   failure.
2. **Only flash what changed.** Done for the empty partitions (like `jag`).
   Could also skip the bootloader/partition table on a re-flash if unchanged.
3. **Skip erase of unchanged regions.** esptool-js `eraseAll:false` already; make
   sure compress is optimal.
4. **Verify + recover UX.** Surface esptool-js's hash verification result; on the
   occasional bad bridge, guide the user through manual download-mode (hold BOOT)
   and reset.
5. **Avoid reflash entirely when possible.** If a device already runs this exact
   SDK's Jaguar, skip flashing and go straight to run. Detect via `identify`
   (`sdkVersion`, `name`, `id`).

## Pointers
- Flash code: `web/web-serial.js#flashParts` (esptool-js `writeFlash`).
- Build: `web/toit-runtime.js#buildFlashParts` runs `flasher/flash-parts.toit`
  (the SDK's `firmware flash` up to where it would call esptool).
