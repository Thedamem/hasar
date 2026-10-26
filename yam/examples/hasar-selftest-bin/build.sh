#!/bin/sh
set -eu
cd "$(dirname "$0")"

VERSION=0.1.1
APP=hasar-selftest
PACKAGE=hasar-selftest-bin

cp ../hasar-selftest/tone.wav tone.wav

docker run --rm \
  -v "$PWD":/home/rust/src \
  -w /home/rust/src \
  messense/rust-musl-cross:aarch64-musl \
  sh -c 'cargo generate-lockfile && cargo build --release --locked'

mkdir -p bin dist
BIN=$(find target -type f -name "$APP" -path '*/release/*' | head -1)
[ -n "$BIN" ] || { echo "binary not found" >&2; exit 1; }
cp "$BIN" "bin/$APP"
chmod 755 "bin/$APP"

rm -f "dist/$PACKAGE-$VERSION.yap"
tar -czf "dist/$PACKAGE-$VERSION.yap" \
  plugin.toml \
  "bin/$APP" \
  tone.wav \
  README.md

ls -lh "bin/$APP" "dist/$PACKAGE-$VERSION.yap"
file "bin/$APP"
