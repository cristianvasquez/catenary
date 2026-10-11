# rdf-files

`rdf-files` reads and writes RDF files on disk and keeps their quads in an in-memory quad store. It detects the RDF format from the file extension, writes a canonical form, patches the text of Turtle files, watches folders, writes several files atomically and commits files with git. It runs in Node only. It does not import any `@catenary` package (`scripts/check-boundaries.mjs` checks this). It depends on `rdf-serialization` for canonical form and Turtle/TriG serialization.

## Modules

`src/index.ts` exports all modules below, except `wasm-memory`.

- `store`: the `QuadStore` interface (`has`, `add`, `delete`, `match`, `select`, `construct`) and the `Bindings` type.
- `oxigraph-store`: `OxigraphStore`, a `QuadStore` on Oxigraph (in-memory, WASM). Also `parseRdfSync` and `oxigraphMemoryBytes`.
- `trap`: `TrapGuard`, a `QuadStore` wrapper that detects a WebAssembly trap. After a trap, each call gives `StoreTrap`. Also `isWasmTrap` and `TRAP_MESSAGE`.
- `terms`: the rdf-ext factory `rdf` (type `RdfFactory`), and `termKey`, `tripleKey` and `mapTerm`.
- `paths`: path rules with the platform as a parameter: `absolutePath`, `pathKey`, `isInside`, `portableRelative`, `resolveStored`, `fileIri`, `knownPath` and the `PathApi` type.
- `formats`: RDF formats by file extension: `RDF_FORMATS`, `formatOf`, `writeProblem`, `parseRdf`, `parseTurtleText`, `canonical` and `serializeRdf`.
- `listing`: the RDF files of a folder and its subfolders: `listRdfFiles`, `ListOptions` and `globRegExp`.
- `text-patch`: text patches of Turtle and TriG files: `patchTurtle`, `patchTurtleDiff`, `StatementDiff`, `PatchResult`, `turtlePosition`, `TextTarget`, `hasAnnotation` and `forgetTurtleTrees`.
- `file-sync`: files on disk as the source of truth: `SerialQueue`, `FolderWatcher`, `WatchOptions`, `OwnWrites`, `isHidden`, `readText`, `Tracked`, `diskChanges`, `readUnchanged` and `writeAll`.
- `git`: git as the history of the files: `git`, `gitChanges` and `commitFiles`.
- `wasm-memory`: internal. It wraps the `WebAssembly.Instance` constructor to find the memory of Oxigraph. `oxigraph-store` imports it before `oxigraph` and exports `oxigraphMemoryBytes`.

The package exports `.` (`lib/index.js` with `lib/index.d.ts`), `./package.json` and `./grammars/*`.

## WASM files at run time

The text patcher parses Turtle and TriG with tree-sitter. It needs two WASM files: `turtle.wasm` and `tree-sitter.wasm` of `web-tree-sitter`. In a bundle, the bundler of the application copies both files next to the script, and the parser loads them from there. Without a bundle, the parser loads `grammars/turtle.wasm` of this package and `tree-sitter.wasm` from `web-tree-sitter`.

## Rebuild the grammar

The script `scripts/build-turtle-grammar.sh` builds `grammars/turtle.wasm` from a pinned commit of tree-sitter-turtle (RDF 1.2 Turtle and TriG). It needs git, curl and docker.

1. Go to the repository root.
2. Run `scripts/build-turtle-grammar.sh`.
3. Run the tests of this package.

If you change the `web-tree-sitter` version, change `CLI` in the script to the same version.

## Limits

- Text patches do not apply to a text with a blank node (`[ … ]`, `( … )`, `_:b`). The patcher gives a reason and no text. The caller then writes the whole file.
- Text patches of TriG apply to one graph block only. A second graph block or a statement outside the graph block gives no text.
- The quad store has no SPARQL UPDATE. `QuadStore` has `select` and `construct` only. Edits use `add` and `delete`.

## Tests

1. Go to the repository root.
2. Run `pnpm --filter rdf-files test`.
