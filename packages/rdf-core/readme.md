# rdf-core

A quad store with graph roles and transactions. Each transaction records a patch. Undo and redo apply a patch backwards and forwards. Each committed patch publishes one change event with the cache inputs that it invalidates. Node only. The package imports no Catenary package: `scripts/check-boundaries.mjs` rejects other imports.

## Modules

| Module | Contents |
|---|---|
| `graph.ts` | `ModelGraph`: the store (a `QuadStore` of rdf-files), the registry of data graphs and shapes graphs, generic reads, SPARQL in the logical data scope, `transact` with its patch log, `undo`, `redo`, `placePending` and `onDidChange`. `Change`, `Patch`, `GraphChange`, `GraphRules`, `GraphNames`. |
| `history.ts` | `History`: the undo and redo stacks (200 steps) and the patch queue of proposed changes. |
| `skolem.ts` | `skolemize` (an IRI `urn:skolem:<uuid>` for each blank node of a read), `isSkolem`, `skolemIri`, and `skolemizer(base)` for another prefix. |
| `terms.ts` | The rdf-ext factory `rdf`, `TermJSON` and `jsonToTerm`. Re-exports the term keys of rdf-files. |
| `plain-quads.ts` | Quads as plain values for `postMessage` to a worker thread, and back. |

## Rules from the caller

The constructor of `ModelGraph` takes `GraphRules`. The caller supplies the view test, the view graphs, the metamodel test, the cache dependencies of one quad and the layout-only test of a patch. Catenary supplies its rules in `packages/rdf/src/model-graph.ts`.

The constructor also takes `GraphNames`: the union graph, the report graph, the data and shapes graph of a file, and the file of a graph. The package owns no graph name: `scripts/check-boundaries.mjs` rejects a string literal that starts with `urn:` in `src`, except the skolem prefix of the contract in `skolem.ts`. Catenary supplies its names in `packages/rdf/src/graph-names.ts`.

The type parameter `P` of `ModelGraph` is the type of the records that a transaction proposes (`proposed`). A transaction starts with no records, and a rollback removes them. The type parameter `C` of `History` is the type of a proposed change in the patch queue. Catenary uses both for the data migrations of a shape edit.

## What it does not do

- No files: rdf-files reads, writes and watches files.
- No placement: `placePending` calls a resolver of the caller. The package has no union policy other than `placePending`.
- No validation, no vocabulary, no views: the caller supplies these rules.
- No blank nodes after a read: `skolemize` replaces them.
