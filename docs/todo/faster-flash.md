# Faster / less destructive flashing

## Why
Flashing currently writes the whole 4 MB image at 0x0 over Web Serial via
esptool-js (~47 s here). It's a one-time-per-device step, but could be nicer.

## Ideas
1. **Higher baud.** esptool-js connects at romBaudrate 115200 then uses 921600.
   Try a higher flash baud (some CP210x/boards do 1.5M+). Measure; fall back on
   failure.
2. **Only flash what's needed.** Instead of a full 0x0 image
   (bootloader+partitions+app), flash just the app partition on re-flash if the
   bootloader/partition table are unchanged (like `jag` does — app at 0x10000).
   Requires knowing offsets; `toit tool firmware` can extract per-partition.
   Keeps re-flash fast and avoids rewriting the bootloader every time.
3. **Skip erase of unchanged regions.** esptool-js `eraseAll:false` already; make
   sure compress is optimal.
4. **Verify + recover UX.** Surface esptool-js's hash verification result; on the
   occasional bad bridge, guide the user through manual download-mode (hold BOOT)
   and reset.
5. **Avoid reflash entirely when possible.** If a device already runs this exact
   SDK's Jaguar, skip flashing and go straight to run. Detect via `identify`
   (`sdkVersion`, `name`, `id`).

## Pointers
- Flash code: `web/web-serial.js#flashImage` (esptool-js `writeFlash`).
- Image build: `web/toit-runtime.js#buildFlashImage` (uses
  `firmware extract --format=image`). For per-partition flashing, see
  `third_party/jaguar/cmd/jag/commands/firmware_flash.go` (offsets, partition
  table handling) and `firmware.toit` format options (`binary` vs `image`).
