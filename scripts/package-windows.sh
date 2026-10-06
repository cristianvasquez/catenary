#!/usr/bin/env bash
# Builds a portable Windows x64 zip of the Electron app (dist/Catenary-win32-x64.zip) on Linux, from the existing build of
# electron-app/ (run `pnpm build` first). No installer: the user extracts the zip and runs Catenary.cmd.
#
# The build output is platform-independent JavaScript, except the native modules. This script replaces them with the Windows x64
# binaries: Electron (win32 zip), node-pty (its own win32-x64 prebuilds), @parcel/watcher and ripgrep (npm platform packages),
# keytar (GitHub prebuild, N-API). Two modules have no Windows prebuild:
#   - drivelist (loaded at backend start): the bundle call bindings("drivelist") is replaced by a JS stub that lists the drive
#     letters A–Z that exist. Only the drive list of the file dialog uses it.
#   - native-keymap (keymapping.node): removed. It loads on first use in a try/catch; Theia then uses the browser keyboard layout.
# Downloads are cached in ${XDG_CACHE_HOME:-~/.cache}/catenary-win.
#
# Usage: scripts/package-windows.sh [--example <folder>]   (--example copies a workspace folder into the zip as example/;
#        Catenary.cmd opens it. Without it, Catenary.cmd opens the last folder, or none.)
set -euo pipefail
root="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
example=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --example) example="$(readlink -f "$2")"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$example" || -d "$example" ]] || { echo "not a folder: $example" >&2; exit 2; }

app="$root/electron-app"
[[ -f "$app/lib/backend/main.js" ]] || { echo "app is not built: run 'pnpm build' in $root" >&2; exit 1; }
[[ -d "$root/app/plugins" ]] || { echo "app/plugins missing: run 'pnpm install' in $root" >&2; exit 1; }

electron_v="$(node -p "require('$(readlink -f "$root/node_modules/electron")/package.json').version")"
pty_dir="$(ls -d "$root"/node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1)"
watcher_v="$(basename "$(ls -d "$root"/node_modules/.pnpm/@parcel+watcher@* | head -1)" | sed 's/.*@//')"
rg_v="$(basename "$(ls -d "$root"/node_modules/.pnpm/@vscode+ripgrep@* | head -1)" | sed 's/.*@//')"
keytar_v="$(basename "$(ls -d "$root"/node_modules/.pnpm/keytar@* | head -1)" | sed 's/.*@//')"

cache="${XDG_CACHE_HOME:-$HOME/.cache}/catenary-win"
mkdir -p "$cache"
fetch() { # url → cached file path
  local f="$cache/$(basename "$1")"
  if [[ ! -s "$f" ]]; then
    curl -fsSL -o "$f.part" "$1" || { echo "download failed: $1" >&2; exit 1; }
    mv -f "$f.part" "$f"
  fi
  printf '%s' "$f"
}
electron_zip="$(fetch "https://github.com/electron/electron/releases/download/v$electron_v/electron-v$electron_v-win32-x64.zip")"
watcher_tgz="$(fetch "https://registry.npmjs.org/@parcel/watcher-win32-x64/-/watcher-win32-x64-$watcher_v.tgz")"
rg_tgz="$(fetch "https://registry.npmjs.org/@vscode/ripgrep-win32-x64/-/ripgrep-win32-x64-$rg_v.tgz")"
keytar_tgz="$(fetch "https://github.com/atom/node-keytar/releases/download/v$keytar_v/keytar-v$keytar_v-napi-v3-win32-x64.tar.gz")"

out="$root/dist/Catenary-win32-x64"
rm -rf "$out" "$out.zip"
mkdir -p "$out"
unzip -q "$electron_zip" -d "$out"
mv "$out/electron.exe" "$out/Catenary.exe"
rm -f "$out/resources/default_app.asar"

res="$out/resources/app"
mkdir -p "$res"
cp "$app/package.json" "$res/"
cp -r "$app/lib" "$res/lib"
cp -r "$root/app/plugins" "$res/plugins"
find "$res/lib" -name '*.map' -delete

native="$res/lib/backend/native"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$watcher_tgz" -C "$tmp" package/watcher.node && mv -f "$tmp/package/watcher.node" "$native/watcher.node"
tar -xzf "$rg_tgz" -C "$tmp" package/bin/rg.exe && mv -f "$tmp/package/bin/rg.exe" "$native/rg.exe"
tar -xzf "$keytar_tgz" -C "$tmp" && mv -f "$tmp/build/Release/keytar.node" "$native/keytar.node"
rm -f "$native/rg" "$native/keymapping.node" "$native/drivelist.node"
rm -rf "$res/lib/prebuilds"
mkdir -p "$res/lib/prebuilds"
cp -r "$pty_dir/prebuilds/win32-x64" "$res/lib/prebuilds/"
find "$res/lib/prebuilds" -name '*.pdb' -delete

# drivelist stub: exactly one call site in the backend bundle, else stop.
main="$res/lib/backend/main.js"
call='var drivelistBindings = bindings("drivelist");'
[[ "$(grep -cF "$call" "$main")" == 1 ]] || { echo "drivelist call site not found once in main.js; the bundle changed" >&2; exit 1; }
stub='var drivelistBindings = { list(cb) { const fs = require("fs"); const drives = []; for (const l of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") { const p = l + ":\\"; try { if (fs.existsSync(p)) drives.push({ device: p, description: p, mountpoints: [{ path: p }], isSystem: l === "C", isVirtual: false, isRemovable: false }); } catch {} } cb(null, drives); } };'
STUB="$stub" CALL="$call" node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(process.env.CALL,()=>process.env.STUB))' "$main"

if [[ -n "$example" ]]; then
  cp -r "$example" "$out/example"
  target='"%~dp0example"'
else
  target=''
fi
# --plugins: the VS Code git extension (Source Control). It needs git.exe on the PATH; without git, Source Control is empty.
printf '@echo off\r\nstart "" "%%~dp0Catenary.exe" %s --plugins=local-dir:"%%~dp0resources\\app\\plugins" %%*\r\n' "$target" > "$out/Catenary.cmd"

(cd "$root/dist" && zip -qr "Catenary-win32-x64.zip" "Catenary-win32-x64")
echo "electron $electron_v, @parcel/watcher $watcher_v, ripgrep $rg_v, keytar $keytar_v, node-pty $(basename "$(dirname "$(dirname "$pty_dir")")" | sed 's/.*@//')"
echo "built: $out.zip ($(du -h "$out.zip" | cut -f1))"
