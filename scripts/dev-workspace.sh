#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"

if [[ -n "${CATENARY_WORKSPACE:-}" ]]; then
  mkdir -p "$CATENARY_WORKSPACE"
  readlink -f "$CATENARY_WORKSPACE"
  exit 0
fi

workspace="${XDG_DATA_HOME:-$HOME/.local/share}/catenary/workspaces/example"
if [[ ! -e "$workspace" ]]; then
  mkdir -p "$workspace"
  cp -R "$root/examples/catalog/." "$workspace/"
else
  [[ -d "$workspace" ]] || { echo "not a workspace folder: $workspace" >&2; exit 1; }
  shopt -s nullglob dotglob
  entries=("$workspace"/*)
  if [[ ${#entries[@]} -eq 0 ]]; then
    cp -R "$root/examples/catalog/." "$workspace/"
  elif [[ ! -f "$workspace/workspace.trig" ]]; then
    echo "existing folder has no workspace.trig, refusing to seed it: $workspace" >&2
    exit 1
  fi
fi
readlink -f "$workspace"
