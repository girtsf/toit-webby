#!/usr/bin/env bash
# Builds the Toit compiler + VM to wasm (see docs/BUILD.md), copies them into
# web/wasm/ and packs build/toit-wasm.tar.gz for the release.
# Needs emcmake/emmake on PATH (emsdk activated). HOST_TOIT overrides the native
# toit used to bootstrap boot snapshots; otherwise the SDK is downloaded.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
source "$ROOT/versions.env"
SRC=$ROOT/third_party/toit
JOBS=${JOBS:-$(nproc)}

if [[ ! -d "$SRC" ]]; then
  git clone --depth 1 --branch "$TOIT_VERSION" https://github.com/toitlang/toit.git "$SRC"
  git -C "$SRC" submodule update --init --depth 1 third_party/esp-idf
  git -C "$SRC/third_party/esp-idf" submodule update --init --depth 1 components/mbedtls/mbedtls
fi

if git -C "$SRC" apply --reverse --check "$ROOT/patches/toit-wasm.patch" 2>/dev/null; then
  echo "patch already applied"
else
  git -C "$SRC" apply "$ROOT/patches/toit-wasm.patch"
fi

if [[ -z "${HOST_TOIT:-}" ]]; then
  SDK=$ROOT/third_party/toit-sdk-$TOIT_VERSION
  if [[ ! -x "$SDK/bin/toit" ]]; then
    mkdir -p "$SDK"
    curl -fsSL --retry 3 "https://github.com/toitlang/toit/releases/download/$TOIT_VERSION/toit-linux-x64.tar.gz" \
      | tar xz -C "$SDK" --strip-components=1
  fi
  HOST_TOIT=$SDK/bin/toit
fi

COMMON="-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker -sFORCE_FILESYSTEM=1 \
-sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sEXPORTED_RUNTIME_METHODS=FS,callMain,ENV -sALLOW_MEMORY_GROWTH=1 \
--preload-file $SRC/lib@/sdk/lib/toit/lib"

configure() {  # <build dir> <extra cmake args...>
  local dir=$1; shift
  emcmake cmake -S "$SRC" -B "$dir" -DCMAKE_BUILD_TYPE=Release \
    -DHOST_TOIT="$HOST_TOIT" -DTOIT_GIT_VERSION="$TOIT_VERSION" "$@"
}

configure "$ROOT/build/wasm" \
  -DCMAKE_EXE_LINKER_FLAGS="$COMMON -sSTACK_SIZE=16MB"
emmake make -C "$ROOT/build/wasm" -j"$JOBS" toit.compile

configure "$ROOT/build/wasm-vm" -DCMAKE_C_FLAGS=-pthread -DCMAKE_CXX_FLAGS=-pthread \
  -DCMAKE_EXE_LINKER_FLAGS="-pthread $COMMON -sINITIAL_MEMORY=64MB -sSTACK_SIZE=8MB \
-sDEFAULT_PTHREAD_STACK_SIZE=1MB -sPTHREAD_POOL_SIZE=8"
emmake make -C "$ROOT/build/wasm-vm" -j"$JOBS" toit

mkdir -p "$ROOT/web/wasm"
cp "$ROOT"/build/wasm/sdk/lib/toit/bin/toit.compile.{js,wasm,data} "$ROOT/web/wasm/"
cp "$ROOT"/build/wasm-vm/sdk/bin/toit.{js,wasm,data} "$ROOT/web/wasm/"
tar czf "$ROOT/build/toit-wasm.tar.gz" -C "$ROOT/web/wasm" \
  toit.compile.js toit.compile.wasm toit.compile.data toit.js toit.wasm toit.data
echo "built: web/wasm/, build/toit-wasm.tar.gz"
