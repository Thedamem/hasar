#!/bin/sh
set -eu
cd "$(dirname "$0")"

VERSION=0.1.1
APP=hasar-agent
PACKAGE=hasar-agent

docker run --rm \
  -v "$PWD":/home/rust/src \
  -w /home/rust/src \
  messense/rust-musl-cross:aarch64-musl \
  cargo build --release --locked

mkdir -p dist/stage/bin
rm -rf dist/stage
mkdir -p dist/stage/bin
cp packaging/plugin.toml dist/stage/plugin.toml
cp target/aarch64-unknown-linux-musl/release/$APP dist/stage/bin/$APP
cp README.md dist/stage/README.md
chmod 755 dist/stage/bin/$APP

rm -f "dist/$PACKAGE-$VERSION.yap"
tar -czf "dist/$PACKAGE-$VERSION.yap" -C dist/stage \
  plugin.toml \
  "bin/$APP" \
  README.md
rm -rf dist/stage

ls -lh "dist/$PACKAGE-$VERSION.yap"
file "target/aarch64-unknown-linux-musl/release/$APP"
