#!/usr/bin/env bash
# Installs a launcher entry (~/.local/share/applications/catenary.desktop) that runs scripts/desktop.sh (the Electron app).
set -euo pipefail
root="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$dir"
cat >"$dir/catenary.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Catenary
Comment=RDF model editor
Exec=$root/scripts/desktop.sh
Icon=applications-graphics
Terminal=false
Categories=Development;
EOF
update-desktop-database "$dir" 2>/dev/null || true
echo "installed: $dir/catenary.desktop"
