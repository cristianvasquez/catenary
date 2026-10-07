#!/usr/bin/env bash
# Runs Catenary as an Electron app (ADR 0005) on a workspace folder, with the plugin host (Source Control). Backend output goes to the
# terminal and to the log file. The window and the backend end together.
# Each workspace has its own Electron profile, so each workspace runs in its own process with its own backend. Electron is
# single-instance per profile: a second launch on the same workspace focuses the open window. --user-data-dir overrides the profile.
# Usage: scripts/desktop.sh [workspace-dir] [electron arguments…]   (default: a copy of examples/bookshop in the Catenary data directory)
set -euo pipefail
root="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
if [[ $# -gt 0 && "$1" != -* ]]; then
  workspace="$(readlink -f "$1")"
  shift
else
  workspace="$(bash "$root/scripts/dev-workspace.sh")"
fi
log="${XDG_STATE_HOME:-$HOME/.local/state}/catenary/backend.log"
mkdir -p "$(dirname "$log")"

if [[ ! -f "$root/electron-app/lib/backend/electron-main.js" ]]; then
  echo "app is not built: run 'pnpm build' in $root" >&2
  exit 1
fi
bash "$root/scripts/install-electron.sh" >/dev/null
electron="$(readlink -f "$root/node_modules/electron")/dist/electron"
profile=()
if [[ " $* " != *" --user-data-dir"* ]]; then
  dir="${XDG_CONFIG_HOME:-$HOME/.config}/catenary/profiles/$(printf '%s' "$workspace" | sha256sum | cut -c1-16)"
  mkdir -p "$dir"
  printf '%s\n' "$workspace" > "$dir/workspace"
  profile=(--user-data-dir="$dir")
fi
cd "$root/electron-app"
# Append: the output of an earlier run stays (a new launch must not erase why the last backend stopped).
printf '\n=== %s catenary %s\n' "$(date -Iseconds)" "$workspace" >> "$log"
export CATENARY_BACKEND_LOG="$log"
exec "$electron" . "$workspace" --plugins=local-dir:"$root/app/plugins" "${profile[@]}" "$@" > >(tee -a "$log") 2>&1
