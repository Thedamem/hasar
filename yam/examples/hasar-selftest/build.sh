#!/bin/sh
set -eu
cd "$(dirname "$0")"
VERSION=0.1.0
mkdir -p dist
rm -f "dist/hasar-selftest-$VERSION.yap"
tar -czf "dist/hasar-selftest-$VERSION.yap" \
  plugin.toml \
  main.lua \
  tone.wav \
  README.md
echo "built dist/hasar-selftest-$VERSION.yap"
