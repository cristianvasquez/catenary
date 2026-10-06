#!/usr/bin/env bash
# Builds the native `drivelist` module that the Theia backend needs.
# node-gyp cannot build it in place when the path contains a space (the include path of
# node-addon-api is split). This script builds a copy in a temporary directory and copies
# the binary back. Run it once after `pnpm install`.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
pkg="$(ls -d "$root"/node_modules/.pnpm/drivelist@*/node_modules | head -1)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/node_modules"
cp -rL "$pkg/drivelist" "$tmp/node_modules/"
addon="$(ls -d "$pkg/node-addon-api" "$root"/node_modules/.pnpm/node-addon-api@*/node_modules/node-addon-api 2>/dev/null | head -1)"
cp -rL "$addon" "$tmp/node_modules/"
(cd "$tmp/node_modules/drivelist" && if command -v node-gyp >/dev/null; then node-gyp rebuild; else npx --yes node-gyp rebuild; fi >/dev/null 2>&1)
mkdir -p "$pkg/drivelist/build/Release"
cp "$tmp/node_modules/drivelist/build/Release/drivelist.node" "$pkg/drivelist/build/Release/"
echo "drivelist.node built: $pkg/drivelist/build/Release/drivelist.node"
