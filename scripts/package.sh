#!/usr/bin/env bash
# Builds a portable package of the Electron app for one target, on Linux x64, from the existing build of electron-app/ (run
# `pnpm build` first). No installer.
#   linux-x64     dist/Catenary-linux-x64.tar.gz   (run ./catenary)
#   win32-x64     dist/Catenary-win32-x64.zip      (run Catenary.exe, or Catenary.cmd)
#   darwin-x64    dist/Catenary-darwin-x64.zip     (Catenary.app, unsigned: the release workflow signs it ad hoc on macOS)
#   darwin-arm64  dist/Catenary-darwin-arm64.zip   (the same, for Apple silicon)
#
# The build output is platform-independent JavaScript, except the native modules. For linux-x64 the script keeps the modules of
# the build. For the other targets it replaces them with the binaries of the target: Electron (release zip), node-pty (its own
# prebuilds), @parcel/watcher and ripgrep (npm platform packages), keytar (GitHub prebuild, N-API). Two modules have no prebuild:
#   - drivelist (loaded at backend start): the bundle call bindings("drivelist") is replaced by a JS stub. On Windows it lists the
#     drive letters A–Z that exist, on macOS "/" and /Volumes/*. Only the drive list of the file dialog uses it.
#   - native-keymap (keymapping.node): removed. It loads on first use in a try/catch; Theia then uses the browser keyboard layout.
# The package starts resources/app/catenary-main.js. It sets THEIA_DEFAULT_PLUGINS to the bundled plugins (Source Control), unless
# the environment sets it, and then loads the Electron main of the build.
# Downloads are cached in ${XDG_CACHE_HOME:-~/.cache}/catenary-package. CATENARY_VERSION sets the version of the package (default:
# the version in electron-app/package.json).
#
# Usage: scripts/package.sh <target> [--example <folder>]   (--example, win32-x64 only: copies a workspace folder into the zip as
#        example/, and Catenary.cmd opens it. Without it, Catenary.cmd opens the last folder, or none.)
set -euo pipefail
root="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
target=""
example=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --example) example="$(readlink -f "$2")"; shift 2 ;;
    linux-x64|win32-x64|darwin-x64|darwin-arm64) target="$1"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$target" ]] || { echo "usage: scripts/package.sh linux-x64|win32-x64|darwin-x64|darwin-arm64 [--example <folder>]" >&2; exit 2; }
[[ -z "$example" || -d "$example" ]] || { echo "not a folder: $example" >&2; exit 2; }
[[ -z "$example" || "$target" == win32-x64 ]] || { echo "--example is only for win32-x64" >&2; exit 2; }
[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || { echo "run this script on Linux x64: the build supplies the linux-x64 native modules" >&2; exit 1; }

app="$root/electron-app"
[[ -f "$app/lib/backend/main.js" ]] || { echo "app is not built: run 'pnpm build' in $root" >&2; exit 1; }
[[ -d "$root/app/plugins" ]] || { echo "app/plugins missing: run 'pnpm install' in $root" >&2; exit 1; }

version="${CATENARY_VERSION:-$(node -p "require('$app/package.json').version")}"
version="${version#v}"
electron_v="$(node -p "require('$(readlink -f "$root/node_modules/electron")/package.json').version")"
pty_dir="$(ls -d "$root"/node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1)"
watcher_v="$(basename "$(ls -d "$root"/node_modules/.pnpm/@parcel+watcher@* | head -1)" | sed 's/.*@//')"
rg_v="$(basename "$(ls -d "$root"/node_modules/.pnpm/@vscode+ripgrep@* | head -1)" | sed 's/.*@//')"
keytar_v="$(basename "$(ls -d "$root"/node_modules/.pnpm/keytar@* | head -1)" | sed 's/.*@//')"

cache="${XDG_CACHE_HOME:-$HOME/.cache}/catenary-package"
mkdir -p "$cache"
fetch() { # url → cached file path
  local f="$cache/$(basename "$1")"
  if [[ ! -s "$f" ]]; then
    curl -fsSL -o "$f.part" "$1" || { echo "download failed: $1" >&2; exit 1; }
    mv -f "$f.part" "$f"
  fi
  printf '%s' "$f"
}
electron_zip="$(fetch "https://github.com/electron/electron/releases/download/v$electron_v/electron-v$electron_v-$target.zip")"

out="$root/dist/Catenary-$target"
rm -rf "$out" "$out.zip" "$out.tar.gz"
mkdir -p "$out"
# unzip keeps the symbolic links of the macOS frameworks.
unzip -q "$electron_zip" -d "$out"
case "$target" in
  linux-x64)
    mv "$out/electron" "$out/catenary"
    res="$out/resources"
    mv "$out/LICENSE" "$out/LICENSE.electron"
    cp "$root/LICENSE" "$out/LICENSE"
    ;;
  win32-x64)
    mv "$out/electron.exe" "$out/Catenary.exe"
    res="$out/resources"
    mv "$out/LICENSE" "$out/LICENSE.electron"
    cp "$root/LICENSE" "$out/LICENSE"
    ;;
  darwin-*)
    mv "$out/Electron.app" "$out/Catenary.app"
    res="$out/Catenary.app/Contents/Resources"
    mv "$out/LICENSE" "$res/LICENSE.electron"
    mv "$out/LICENSES.chromium.html" "$res/LICENSES.chromium.html"
    # Name, identifier and version of the bundle. The executable stays Contents/MacOS/Electron.
    VERSION="$version" node -e '
      const fs = require("fs"); const f = process.argv[1]; let s = fs.readFileSync(f, "utf8");
      const set = (key, value) => {
        const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
        if (!re.test(s)) { console.error(`Info.plist: no ${key}`); process.exit(1); }
        s = s.replace(re, (_, a, b) => a + value + b);
      };
      set("CFBundleName", "Catenary"); set("CFBundleDisplayName", "Catenary");
      set("CFBundleIdentifier", "io.github.cristianvasquez.catenary");
      set("CFBundleShortVersionString", process.env.VERSION); set("CFBundleVersion", process.env.VERSION);
      fs.writeFileSync(f, s);' "$out/Catenary.app/Contents/Info.plist"
    ;;
esac
rm -f "$res/default_app.asar"

app_res="$res/app"
mkdir -p "$app_res"
cp -r "$app/lib" "$app_res/lib"
cp -r "$root/app/plugins" "$app_res/plugins"
cp "$root/LICENSE" "$app_res/LICENSE"
find "$app_res/lib" -name '*.map' -delete
VERSION="$version" node -e '
  const fs = require("fs"); const [from, to] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(from, "utf8"));
  Object.assign(pkg, { version: process.env.VERSION, main: "catenary-main.js", license: "AGPL-3.0-or-later" });
  fs.writeFileSync(to, JSON.stringify(pkg, null, 2) + "\n");' "$app/package.json" "$app_res/package.json"
cat > "$app_res/catenary-main.js" <<'EOF'
// Packaged Catenary (scripts/package.sh): load the bundled plugins (Source Control), then the Electron main of the build.
const path = require('path');
process.env.THEIA_DEFAULT_PLUGINS ??= `local-dir:${path.join(__dirname, 'plugins')}`;
require('./lib/backend/electron-main.js');
EOF

if [[ "$target" != linux-x64 ]]; then
  case "$target" in
    win32-x64)
      keytar_target="win32-x64"; rg_bin="rg.exe" ;;
    darwin-*)
      keytar_target="$target"; rg_bin="rg" ;;
  esac
  watcher_tgz="$(fetch "https://registry.npmjs.org/@parcel/watcher-$target/-/watcher-$target-$watcher_v.tgz")"
  rg_tgz="$(fetch "https://registry.npmjs.org/@vscode/ripgrep-$target/-/ripgrep-$target-$rg_v.tgz")"
  keytar_tgz="$(fetch "https://github.com/atom/node-keytar/releases/download/v$keytar_v/keytar-v$keytar_v-napi-v3-$keytar_target.tar.gz")"

  native="$app_res/lib/backend/native"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  tar -xzf "$watcher_tgz" -C "$tmp" package/watcher.node && mv -f "$tmp/package/watcher.node" "$native/watcher.node"
  tar -xzf "$rg_tgz" -C "$tmp" "package/bin/$rg_bin" && mv -f "$tmp/package/bin/$rg_bin" "$native/$rg_bin"
  tar -xzf "$keytar_tgz" -C "$tmp" && mv -f "$tmp/build/Release/keytar.node" "$native/keytar.node"
  [[ "$rg_bin" == rg ]] || rm -f "$native/rg"
  rm -f "$native/keymapping.node" "$native/drivelist.node"
  rm -rf "$app_res/lib/prebuilds"
  mkdir -p "$app_res/lib/prebuilds"
  cp -r "$pty_dir/prebuilds/$target" "$app_res/lib/prebuilds/"
  find "$app_res/lib/prebuilds" -name '*.pdb' -delete

  # drivelist stub: exactly one call site in the backend bundle, else stop.
  main="$app_res/lib/backend/main.js"
  call='var drivelistBindings = bindings("drivelist");'
  [[ "$(grep -cF "$call" "$main")" == 1 ]] || { echo "drivelist call site not found once in main.js; the bundle changed" >&2; exit 1; }
  stub='var drivelistBindings = { list(cb) { const fs = require("fs"); const drives = []; const add = (p, isSystem) => drives.push({ device: p, description: p, mountpoints: [{ path: p }], isSystem, isVirtual: false, isRemovable: false }); if (process.platform === "win32") { for (const l of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") { const p = l + ":\\"; try { if (fs.existsSync(p)) add(p, l === "C"); } catch {} } } else { add("/", true); try { for (const v of fs.readdirSync("/Volumes")) add("/Volumes/" + v, false); } catch {} } cb(null, drives); } };'
  STUB="$stub" CALL="$call" node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(process.env.CALL,()=>process.env.STUB))' "$main"
fi

case "$target" in
  linux-x64)
    (cd "$root/dist" && tar -czf "Catenary-$target.tar.gz" "Catenary-$target")
    artifact="$out.tar.gz"
    ;;
  win32-x64)
    if [[ -n "$example" ]]; then
      cp -r "$example" "$out/example"
      target_arg='"%~dp0example"'
    else
      target_arg=''
    fi
    # Source Control needs git.exe on the PATH. Without git, Source Control is empty.
    printf '@echo off\r\nstart "" "%%~dp0Catenary.exe" %s %%*\r\n' "$target_arg" > "$out/Catenary.cmd"
    (cd "$root/dist" && zip -qr "Catenary-$target.zip" "Catenary-$target")
    artifact="$out.zip"
    ;;
  darwin-*)
    # -y stores the symbolic links of the frameworks as links.
    (cd "$out" && zip -qry "$out.zip" Catenary.app)
    artifact="$out.zip"
    ;;
esac
echo "catenary $version ($target): electron $electron_v, @parcel/watcher $watcher_v, ripgrep $rg_v, keytar $keytar_v, node-pty $(basename "$(dirname "$(dirname "$pty_dir")")" | sed 's/.*@//')"
echo "built: $artifact ($(du -h "$artifact" | cut -f1))"
