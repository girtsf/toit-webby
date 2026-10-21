// Copyright (C) 2026 Girts Folkmanis.
// Use of this source code is governed by an MIT-style license that can be
// found in the LICENSE file.

// `toit decode` for the browser: decodes a base64 system message (e.g. the
// stack trace of an uncaught exception), with symbols if one of the given
// snapshots is the program that produced it. The SDK's own `toit decode` writes through host pipes,
// which the wasm VM doesn't have; this prints instead. Built next to the SDK's
// tools/{mirror,snapshot,system-message_}.toit by tools/build-snapshots.sh.
//
// Usage: decode <base64-message> [<snapshot>...]

import encoding.base64
import host.file
import .mirror as mirror
import .snapshot
import .system-message_

main args:
  message := decode-system-message (base64.decode args[0]) --if-error=:
    print it
    exit 1
  program := null
  args[1..].do: | path/string |
    bundle := SnapshotBundle (file.read-contents path)
    // A trace from another program would get wrong symbols.
    if not program and bundle.uuid == message.program-uuid: program = bundle.decode
  m := mirror.decode message.payload program --if-error=:
    print it
    exit 1
  print m.stringify
