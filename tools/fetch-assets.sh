#!/usr/bin/env bash
# Populates the gitignored web/{assets,vendor,wasm} from pinned releases.
# (The Jaguar* snapshot is built by tools/build-snapshots.sh instead.)
# SKIP_WASM=1 leaves web/wasm alone (e.g. after a local tools/build-wasm.sh).
# WASM_REPO=owner/name overrides where the wasm release is fetched from.
# ENVELOPES=<regex> limits which envelopes are fetched (default: all ESP32 ones),
# e.g. ENVELOPES='^esp32s3$' for local development.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/versions.env"
WEB=$ROOT/web
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

dl() { curl -fsSL --retry 3 -o "$2" "$1"; }

mkdir -p "$WEB/assets" "$WEB/vendor" "$WEB/wasm"

ENVELOPES=${ENVELOPES:-^esp32}
AUTH=()
[[ -n "${GITHUB_TOKEN:-}" ]] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
mapfile -t names < <(curl -fsSL --retry 3 "${AUTH[@]}" \
    "https://api.github.com/repos/toitlang/envelopes/releases/tags/$TOIT_VERSION" \
  | jq -r '.assets[].name | capture("^firmware-(?<n>.+)\\.envelope\\.gz$").n' \
  | grep -E -- "$ENVELOPES" | grep -v -- '-qemu$' | sort)
[[ ${#names[@]} -gt 0 ]] || { echo "no envelopes match '$ENVELOPES'" >&2; exit 1; }
for n in "${names[@]}"; do
  echo "envelope $TOIT_VERSION $n"
  dl "https://github.com/toitlang/envelopes/releases/download/$TOIT_VERSION/firmware-$n.envelope.gz" \
    "$WEB/assets/firmware-$n.envelope.gz"
done
printf '%s\n' "${names[@]}" | jq -R . | jq -s . > "$WEB/assets/envelopes.json"

# Jaguar's partition-table overrides (cmd/jag/commands/partitions.go): with this
# SDK the C3/C6 firmware outgrows the envelopes' default OTA partitions.
for chip in esp32c3 esp32c6; do
  echo "partitions $JAGUAR_VERSION $chip"
  dl "https://raw.githubusercontent.com/toitlang/jaguar/$JAGUAR_VERSION/cmd/jag/commands/partitions/$chip.csv" \
    "$WEB/assets/partitions-$chip.csv"
done

echo "esptool-js $ESPTOOL_JS_VERSION"
dl "https://registry.npmjs.org/esptool-js/-/esptool-js-$ESPTOOL_JS_VERSION.tgz" "$TMP/esptool-js.tgz"
tar xzf "$TMP/esptool-js.tgz" -C "$TMP" package/bundle.js
cp "$TMP/package/bundle.js" "$WEB/vendor/esptool-js.js"

# Uncompressed sizes for download progress (Pages serves these gzipped).
write_sizes() {
  (cd "$WEB" && find assets wasm -type f -printf '%p\t%s\n' | sort) \
    | jq -R 'split("\t") | {(.[0]): (.[1] | tonumber)}' | jq -s add > "$WEB/sizes.json"
}

if [[ "${SKIP_WASM:-}" == 1 ]]; then
  echo "wasm: skipped"
  write_sizes
  exit 0
fi
if [[ -z "${WASM_REPO:-}" ]]; then
  WASM_REPO=${GITHUB_REPOSITORY:-$(git -C "$ROOT" remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')}
fi
echo "wasm $WASM_TAG from $WASM_REPO"
dl "https://github.com/$WASM_REPO/releases/download/$WASM_TAG/toit-wasm.tar.gz" "$TMP/toit-wasm.tar.gz"
tar xzf "$TMP/toit-wasm.tar.gz" -C "$WEB/wasm"
write_sizes
