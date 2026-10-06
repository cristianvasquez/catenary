#!/usr/bin/env bash
# Puts the Electron binary in node_modules/electron/dist. Its install.js downloads the zip to ~/.cache/electron, but with Node 26
# its extract-zip ends without an error before the extraction is complete (dist has only locales/). This script extracts the zip
# with `unzip` and writes path.txt, as install.js does. Nothing to do when dist/version has the version of the package.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
pkg="$(readlink -f "$root/node_modules/electron")"
version="$(node -p "require('$pkg/package.json').version")"
[[ "$(cat "$pkg/dist/version" 2>/dev/null)" == "$version" ]] && exit 0
(cd "$pkg" && node install.js) || true
zip="$(ls "${ELECTRON_CACHE:-$HOME/.cache/electron}"/*/electron-v"$version"-linux-x64.zip 2>/dev/null | head -1)"
[[ -n "$zip" ]] || { echo "electron $version: zip not downloaded" >&2; exit 1; }
rm -rf "$pkg/dist" && mkdir -p "$pkg/dist" && unzip -q "$zip" -d "$pkg/dist"
printf 'electron' > "$pkg/path.txt"
echo "electron $version: $("$pkg/dist/electron" --version)"
