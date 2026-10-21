// Copyright (C) 2026 Girts Folkmanis.
// Use of this source code is governed by an MIT-style license that can be
// found in the LICENSE file.

// `toit tool firmware flash` for the browser, minus esptool: builds the same
// pieces with the SDK's own code (build-esp32-image in tools/firmware.toit)
// and writes them to a directory instead of handing them to esptool; the page
// writes them with esptool-js. Built next to the SDK's tools/firmware.toit by
// tools/build-snapshots.sh.
//
// With --flash-size-mb, a bigger flash than the partition table covers gets a
// 'data' partition (type 0x41, like the envelopes' "-16mb" variants) over the
// rest, and the bootloader is stamped with that size. The new partition isn't
// written, like any partition `firmware flash` has no content for.
//
// Output: <output>/<offset in hex>.bin for each piece, and
// <output>/flashing.json: {"chip": ..., "flashing": <envelope's flashing.json,
// updated>, "flash-size-mb": ...}.

import cli
import encoding.json
import encoding.ubjson
import host.directory
import host.file
import partition-table show *
import .firmware

// 32 MB and up need 32-bit flash addressing, which the envelopes don't enable.
MAX-FLASH-SIZE-MB ::= 16

main arguments/List:
  cmd := cli.Command "flash-parts"
      --options=[
        cli.OptionPath OPTION-ENVELOPE --short-name="e" --required,
        cli.OptionPath "config",
        cli.OptionPatterns "partition"
            ["file:<name>=<path>", "empty:<name>=<size>"]
            --split-commas
            --multi,
        cli.OptionPath "partitions",
        cli.OptionInt "flash-size-mb",
        cli.OptionPath "output" --short-name="o" --required,
      ]
      --run=:: flash-parts it
  cmd.run arguments

flash-parts invocation/cli.Invocation -> none:
  ui := invocation.cli.ui
  envelope := Envelope.load invocation[OPTION-ENVELOPE] --ui=ui
  if envelope.kind != Envelope.KIND-ESP32: ui.abort "Only ESP32 envelopes are supported."

  // As in `flash`.
  config-encoded := ByteArray 0
  if config-path := invocation["config"]:
    config-encoded = read-file config-path --ui=ui
    exception := catch: ubjson.decode config-encoded
    if exception: config-encoded = ubjson.encode (json.decode config-encoded)

  build-esp32-image invocation envelope --config-encoded=config-encoded
      --write=: | partitions/Map chip/string flashing/Map |
        if flash-size-mb := invocation["flash-size-mb"]:
          grow partitions flashing (min flash-size-mb MAX-FLASH-SIZE-MB) --ui=ui
        output := invocation["output"]
        directory.mkdir --recursive output
        partitions.do: | offset/int content/ByteArray |
          write-file "$output/$(%x offset).bin" --ui=ui: it.write content
        flash-size := parse-flash-size_ flashing["flash_settings"]["flash_size"] --ui=ui
        info := {"chip": chip, "flashing": flashing, "flash-size-mb": flash-size / 0x100000}
        write-file "$output/flashing.json" --ui=ui: it.write (json.encode info)

/** Extends the image to $flash-size-mb with a 'data' partition, if it is smaller. */
grow partitions/Map flashing/Map flash-size-mb/int --ui/cli.Ui -> none:
  flash-size := flash-size-mb * 0x100000
  table-offset := int.parse flashing["partition-table"]["offset"][2..] --radix=16
  table := PartitionTable.decode partitions[table-offset]
  free := table.find-first-free-offset
  if free >= flash-size: return
  table.add (Partition
      --name="data"
      --type=0x41
      --subtype=0
      --offset=free
      --size=flash-size - free
      --flags=1)
  partitions[table-offset] = table.encode
  // As build-esp32-image does when the partition table outgrows the envelope.
  bootloader-offset := int.parse flashing["bootloader"]["offset"][2..] --radix=16
  bootloader := Esp32Binary partitions[bootloader-offset]
  bootloader.set-flash-size-mb flash-size-mb
  partitions[bootloader-offset] = bootloader.bits
  flashing["flash_settings"]["flash_size"] = "$(flash-size-mb)MB"
  update-write-flash-size_ flashing "$(flash-size-mb)MB"
