#!/usr/bin/env bash
# Builds packages/rdf-files/grammars/turtle.wasm (Turtle + TriG grammar for web-tree-sitter) from a pinned commit.
# Needs git, curl and docker (the tree-sitter CLI compiles to WASM in the emscripten/emsdk image).
set -euo pipefail
REPO=https://github.com/cristianvasquez/tree-sitter-turtle.git
COMMIT=12d276289315f7a800ba1b1685156bfc99d9488f   # branch rdf-1.2, RDF 1.2 Turtle and TriG (fork of GordianDziwis/tree-sitter-turtle)
CLI=v0.25.10                                      # must match the web-tree-sitter version of packages/rdf
out="$(cd "$(dirname "$0")/.." && pwd)/packages/rdf-files/grammars/turtle.wasm"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
git clone -q "$REPO" "$tmp/g" && git -C "$tmp/g" checkout -q "$COMMIT"
curl -sSL "https://github.com/tree-sitter/tree-sitter/releases/download/$CLI/tree-sitter-linux-x64.gz" | gunzip > "$tmp/ts" && chmod +x "$tmp/ts"
cat > "$tmp/g/tree-sitter.json" <<'JSON'
{"grammars":[{"name":"turtle","camelcase":"Turtle","scope":"source.turtle","path":".","file-types":["ttl","trig"]}],"metadata":{"version":"0.2.0","license":"MIT","description":"Turtle","links":{"repository":"https://github.com/cristianvasquez/tree-sitter-turtle"}}}
JSON
(cd "$tmp/g" && "$tmp/ts" build --wasm -o "$tmp/turtle.wasm")
cp "$tmp/turtle.wasm" "$out"
echo "wrote $out"
