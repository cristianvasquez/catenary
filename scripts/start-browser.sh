#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
workspace="$(bash "$root/scripts/dev-workspace.sh")"
cd "$root/app"
exec pnpm exec theia start "$workspace" --port 3100 --plugins=local-dir:plugins
