#!/usr/bin/env bash
# Builds the Toit snapshots the app serves, with the native Toit SDK
# (third_party/toit-sdk-$TOIT_VERSION, downloaded if missing):
#
# - web/assets/jaguar-webby.snapshot: Jaguar* = upstream Jaguar at
#   $JAGUAR_VERSION + patches/jaguar-webby.patch + device/*.toit.
# - web/assets/decode.snapshot: decoder/decode.toit + the SDK's trace decoding
#   sources (tools/{mirror,snapshot,system-message_}.toit at $TOIT_VERSION).
#
# The Jaguar checkout in build/jaguar-webby is reset on every run. To change
# the patch, edit there, then:
#   git -C build/jaguar-webby diff -- package.yaml package.lock src/jaguar.toit src/network.toit \
#     > patches/jaguar-webby.patch
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/versions.env"
SDK=$ROOT/third_party/toit-sdk-$TOIT_VERSION
TOIT=$SDK/bin/toit
ASSETS=$ROOT/web/assets
mkdir -p "$ASSETS"

if [[ ! -x "$TOIT" ]]; then
  echo "toit SDK $TOIT_VERSION"
  mkdir -p "$SDK"
  curl -fsSL --retry 3 "https://github.com/toitlang/toit/releases/download/$TOIT_VERSION/toit-linux.tar.gz" \
    | tar xz -C "$SDK" --strip-components=1
fi

# Jaguar*.
SRC=$ROOT/build/jaguar-webby
if [[ ! -d "$SRC/.git" ]]; then
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$JAGUAR_VERSION" \
    https://github.com/toitlang/jaguar "$SRC"
fi
git -C "$SRC" checkout -q -f "$JAGUAR_VERSION"
git -C "$SRC" clean -fdq -e .packages
git -C "$SRC" apply "$ROOT/patches/jaguar-webby.patch"
cp "$ROOT"/device/*.toit "$SRC/src/"
(cd "$SRC" && "$TOIT" pkg install >/dev/null)
"$TOIT" analyze "$SRC/src/jaguar.toit"
"$TOIT" compile -O2 --snapshot -o "$ASSETS/jaguar-webby.snapshot" "$SRC/src/jaguar.toit"
echo "jaguar* -> $ASSETS/jaguar-webby.snapshot"

# Trace decoder.
DEC=$ROOT/build/decoder
rm -rf "$DEC"
mkdir -p "$DEC"
for f in mirror snapshot system-message_; do
  curl -fsSL --retry 3 -o "$DEC/$f.toit" \
    "https://raw.githubusercontent.com/toitlang/toit/$TOIT_VERSION/tools/$f.toit"
done
cp "$ROOT"/decoder/{decode.toit,package.yaml,package.lock} "$DEC/"
(cd "$DEC" && "$TOIT" pkg install >/dev/null)
"$TOIT" compile -O2 --snapshot -o "$ASSETS/decode.snapshot" "$DEC/decode.toit"
echo "decoder -> $ASSETS/decode.snapshot"
