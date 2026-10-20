# Architecture

This document describes the structure of the code and the flow of data. The exact contracts are in the [data contract](../spec/manifest.hs).

## Data flow

```text
 RDF files on disk  ──read / watch──▶  ModelStore (backend, one per workspace)
        ▲                               ├─ QuadStore on Oxigraph (in memory)
        │                               ├─ file data and shapes graphs
   text patch / write                   ├─ history: undo, redo, migration queue
   + git commit                         └─ validation (shacl-engine, worker thread)
        │                                        │
        └──────────── file queue ◀── patch ──────┤
                                                 │ SPARQL queries, EditCommand
                         ┌───────────────────────┴───────────────────────┐
                    RPC (JSON)                                      GLSP server
                         │                                    (one session per open view)
                 Theia frontend: panels                          canvas widgets
          (Model explorer, Properties, Links, ...)
```

1. Open: the backend lists the model files, parses them, replaces blank nodes with skolem IRIs and loads the quads into the store. Each quad graph records its file and role.
2. Read: each panel and each view session asks the backend for what it shows. The backend answers with a SPARQL query, and builds a request-scoped read model when a rule needs one. No component holds a copy of the whole model.
3. Edit: the frontend or a GLSP handler sends one `EditCommand`. The store runs it in one synchronous transaction and produces one patch (added and removed quads) and one undo step.
4. Write: the file queue writes the patch to the files that hold the statements, as a text patch when possible (Turtle, or the graph block of a TriG view file), else as a whole file. A Git commit of those files follows 60 s after the last content edit, or at a save (manifest §10.3).
5. Notify: each patch produces one event with its changed graphs and elements. `change.ts` gives the patch one tier: a view patch, a data patch or a rebuild. A view patch changes placement geometry or style only. A rebuild follows a shapes change, a disk read or an open. Caches retain the last event that affects their input. Connections receive snapshots with event sequence numbers, file state and the change scope with its tier. A panel reads again only when the scope touches it.
6. Refresh: each canvas session keeps the read model (Doc) of its view and applies the change by tier (manifest §11.3).
   - A view patch goes into the kept Doc in place. Only the canvases of that view refresh.
   - A data patch reads the changed elements again with a scoped read and merges them into the kept Doc. A placement change or a new placed relation reads the view again.
   - A rebuild reads the view again.
   - The store keeps the SHACL target matches, the hidden neighbor counts, the figure input and the dataset warnings. It updates them from each patch. After each change, a kept Doc or kept read equals a fresh read (`law_keptDocEqualsRead`, `law_keptReadsEqualRead`).
   - A hidden canvas tab refreshes nothing. It refreshes once when it is shown. A reveal on that canvas waits for the update of the show.
7. Validate: 250 ms after a data or shape change, SHACL runs in a worker thread. The report goes to the unsaved report graph `urn:catenary:report`. A validation run refreshes only the canvases whose violation counts changed.
8. Recover: a WebAssembly trap in Oxigraph stops that store (`trap.ts`). ModelStore builds a new store, reads the files again once, clears undo and shows one warning. A trap during that read stops with one error (manifest §3.4).

The frontend holds one selection per window (ui-manifest §3.3). The canvas that made it (the origin) holds it as its GLSP selection. Other canvases show a local highlight and send nothing to the server. A file Model document reads only the store graphs of its file: each row is a subject with a statement in that file.

## Store layout

| Graph | Content |
|---|---|
| `<view IRI>` | The statements of one view file. |
| `urn:shapes:<encoded path>` | Shape subjects and their nested nodes, per source file. |
| `urn:data:<encoded path>` | Other statements, per source file. |
| `urn:catenary:report` | The SHACL report. Not saved, not in undo, not in the dirty check. |

Model-file reads preserve SPO statements and source-file provenance, not source graph names. Catenary assigns the store graphs above instead. View files retain their required view graph IRI. Writes do not restore source graph names.

Data reads use a union of the file data graphs with duplicate triples removed. `ModelGraph.union` (`urn:name:model`) is this logical scope. Commands assign final file graphs before they commit. History stores only quad patches and the migration queue. Canonical file content determines dirty state. Touched graphs invalidate only their file cache entries.

The workspace file (`workspace.trig`, graph `urn:name:workspace`) stays in workspace metadata, outside the store graphs above. The `urn:trellis:list:*` identifiers remain because saved view files use them.

## Packages

Imports flow from `modeler` to `@catenary/rdf` and `@catenary/model`. `@catenary/model` imports `@catenary/contracts` and `@catenary/shacl/common`. `@catenary/shacl` and `@catenary/rdfs` import only `@catenary/contracts`. `@catenary/contracts` imports no Catenary package. `@catenary/rdf` imports `@catenary/shacl/backend`, `@catenary/rdfs`, `@catenary/contracts`, `@catenary/model`, `rdf-core`, `rdf-files` and `rdf-serialization`. `rdf-core` imports only `rdf-files`, `rdf-serialization`, RDF libraries and Node built-ins. `rdf-files` imports `rdf-serialization`. In `rdf-core`, `graph.ts` imports only `terms.ts`. `rdf-core/src` contains no string literal that starts with `urn:`: the host supplies the IRI values. `scripts/check-boundaries.mjs` rejects other imports and these literals.

| Package | Responsibility | Allowed dependencies |
|---|---|---|
| `packages/contracts` (`@catenary/contracts`) | The contracts between the host and a vocabulary plugin, one module each. `query`: the query port (SPARQL SELECT, graph patterns, labels), the namespaces and the IRI escaper. `explorer`: the Model explorer (sections, rows, paths, the explorer port). `palette`: the palette and the class picker (classes, with name, description and order). `links`: the link picker and drawn and reconnected edges (class, predicate, target class, cardinality). `fields`: the Properties form and the card fields (class, predicate, datatype or values, cardinality). `related`: the Related sections of the Links tab (sections of element rows, on the explorer port). | None. |
| `packages/shacl` (`@catenary/shacl`) | The SHACL plugin: the Shapes section of the Model explorer; the "Same target class" section of the Links tab; the palette classes, links and fields of the shapes. Also SHACL target types, applicability queries, form predicates, connection rules and notation assets. | `@catenary/contracts`. Hosts supply query ports and graph identities. |
| `packages/rdfs` (`@catenary/rdfs`) | The RDFS plugin: the Classes section of the Model explorer (classes, subclasses and instances as written); the palette classes, links and fields of `rdfs:domain` and `rdfs:range`. | `@catenary/contracts`. |
| `packages/model` (`@catenary/model`) | JSON types, commands, query declarations, pure rules on read models, the merge of the plugins into the metamodel. Runs in Node and the browser. | `canonical-md`, `@catenary/contracts`, `@catenary/shacl/common`. No RDF library, UI framework or Node built-in. |
| `packages/rdf-serialization` (`rdf-serialization`) | Vendored RDF canonicalization and Turtle/TriG serialization. Exports ESM and CommonJS. | RDF libraries, Node built-ins. No Catenary package. |
| `packages/rdf-files` | Generic RDF files and quad store: formats, canonical write, text patches of Turtle and of a TriG graph block, folder watch, atomic writes, Git, Oxigraph store and its trap guard. Usable outside Catenary. | `rdf-serialization`, RDF libraries, Node built-ins. No `@catenary/*`. |
| `packages/rdf-core` | Generic transaction core: `ModelGraph` (the store, graph roles, SPARQL in the logical data scope, transactions with a patch log, undo, redo, change events), `History`, skolemization, terms, plain quads for worker threads. The caller supplies the vocabulary and cache rules and the graph names. The skolem prefix `urn:skolem:` is a value of the contract. Usable outside Catenary. | `rdf-files`, `rdf-serialization`, RDF libraries, Node built-ins. No `@catenary/*`. |
| `packages/rdf` (`@catenary/rdf`) | `ModelStore`: operations, queries, validation, persistence. Runs the plugins; parses no vocabulary for the metamodel. Node only. | `@catenary/shacl`, `@catenary/rdfs`, `@catenary/contracts`, `@catenary/model`, `rdf-core`, `rdf-files`, `rdf-serialization`, RDF libraries, Node built-ins. No Theia, GLSP, React or DOM. |
| `modeler` | Theia extension: RPC service, GLSP adapters, panels, canvas. | `@catenary/model`. Only `src/node` imports `@catenary/rdf`. |
| `app`, `electron-app` | Browser host and desktop host. | Theia packages and `modeler`. |

Values that cross a package boundary are JSON, including RDF terms and IDs.

### Add a Model explorer section

1. Implement `ExplorerPlugin` (`packages/contracts/src/explorer.ts`) in the package of the vocabulary. Query only through the `ExplorerPort`.
2. Add the plugin to `EXPLORER_PLUGINS` (`packages/rdf/src/explorer.ts`).

### Vocabulary plugins

Each reader of the metamodel has its own provider contract, named after it. A vocabulary plugin implements the contracts it can. It reads its statements only through the query port. The host runs the plugins and merges them. A reader reads only the merged result, never a plugin.

```text
 READERS (modeler)   Model explorer      Palette            Links                   Properties
                     tree of sections    class picker,      link picker, draw and   the form,
                                         card colors        reconnect edges         fields on cards
                          │ reads             │ reads             │ reads                 │ reads
 CONTRACTS           ┌────▼─────┐        ┌────▼─────┐        ┌────▼──────────┐       ┌────▼──────────┐
 (types only)        │ explorer │        │ palette  │        │ links         │       │ fields        │
                     │ sections,│        │ classes: │        │ (class, pred, │       │ (class, pred, │
                     │ rows     │        │ name,    │        │ target class, │       │ datatype | in,│
                     │          │        │ order    │        │ min, max)     │       │ min, max)     │
                     └────┬─────┘        └────┬─────┘        └──────┬────────┘       └──────┬────────┘
                          └──────────────┬────┴─────────────────────┴───────────────────────┘
                                   query: the port every provider reads through (SPARQL, graphs, labels)
                          ┌──────────────┴──────────────────────────────────────────────┐
 PLUGINS             shacl (shapes graphs)                          rdfs (all files)
                     explorer: Shapes section                       explorer: Classes section
                     palette: sh:targetClass classes                palette: rdfs:domain classes
                     links: sh:path + sh:class | sh:node            links: rdfs:domain + class rdfs:range
                     fields: sh:path + sh:datatype | sh:in          fields: rdfs:domain + literal rdfs:range
                     only SHACL: validation (Problems)              no cardinality, no validation
                          └──────────────┬──────────────────────────────────────────────┘
 HOST                rdf (ModelStore): owns the store, gives each plugin a port, runs [shacl, rdfs] for each
                     contract (authoring.ts, explorer.ts); model merges them (mergeContributions): SHACL wins
                     for a class and a predicate.
```

To add a plugin:

1. Implement the contracts that the vocabulary can give in its package: `PaletteProvider`, `LinksProvider`, `FieldsProvider` and `ExplorerPlugin` (`packages/contracts/src`). Import them from `@catenary/contracts`. Query only through the port.
2. Add it to `AUTHORING_PLUGINS` (`packages/rdf/src/authoring.ts`) with the graphs it reads, and its explorer plugin to `EXPLORER_PLUGINS` (`packages/rdf/src/explorer.ts`). The order of `AUTHORING_PLUGINS` is the precedence: for a class and a predicate, the first plugin that gives a link or a field wins.

`RelatedProvider` (`packages/contracts/src/related.ts`) gives the Links tab extra top-level folders. The host runs `RELATED_PROVIDERS` (`packages/rdf/src/explorer.ts`) with an explorer port over the graphs of all model files.

Validation never reads the plugins: it reads the shapes.

### Add a read query for the frontend

1. Declare it in `ModelQueries` and `MODEL_QUERIES` (`packages/model/src/queries.ts`).
2. Implement it in `PanelReads` (`packages/rdf/src/panel-reads.ts`). Use a read module for its queries and rules.
3. Call it as `service.<name>(…)` in the frontend.

The RPC service and `catenary rpc` take the query from `MODEL_QUERIES`. The compiler rejects a missing step. Do not edit `protocol.ts` or `model-service.ts` for a query.

## Code map

Paths are relative to the directory in the first column.

| Directory | Files | Purpose |
|---|---|---|
| `packages/contracts/src` | `query.ts` | Query port, namespaces and the IRI escaper |
| | `explorer.ts` | Model explorer contract |
| | `palette.ts`, `links.ts`, `fields.ts` | Palette, links and fields contracts |
| | `related.ts` | Related sections of the Links tab contract |
| | `index.ts` | Re-exports the six modules |
| `packages/shacl/src` | `common/index.ts`, `backend/targets.ts`, `backend/node.ts`, `backend/form.ts` | Target declarations, query ports, direct targeting, node constraints, form predicates and connection rules |
| | `backend/explorer.ts` | Shapes section of the Model explorer |
| | `backend/related.ts` | "Same target class" section of the Links tab |
| | `backend/authoring.ts` | Palette classes, links and fields of the shapes |
| `packages/rdfs/src` | `explorer.ts` | Classes section of the Model explorer |
| | `domain-range.ts` | Palette classes, links and fields of `rdfs:domain` and `rdfs:range` |
| `packages/shacl/notations` | `shapes.ttl` | SHACL figure definitions |
| `packages/model/src` | `doc.ts`, `terms.ts`, `ids.ts`, `snapshot.ts`, `trace.ts`, `trace-metrics.ts` | Read-model records, JSON terms, element IDs, snapshot schema, trace records and metric calculations |
| | `commands.ts`, `actions.ts`, `queries.ts` | Edit commands, action applicability, read-query declarations |
| | `command-schema.json` | Kinds, fields and docs of the edit commands, generated from `commands.ts` by `scripts/gen-command-schema.mjs` (`exec --schema`) |
| | `paste-layout.ts` | Packs new placements around fixed boxes and moves copied frames with their contents |
| | `metamodel.ts`, `shapes-doc.ts`, `form.ts` | Shapes, ranges, the merge of the plugins, prefixes, form conversion |
| | `relation-refusal.ts` | The facts and the message of a refused relation (createRelation, reconnect, `canRelate`) |
| | `compact-view.ts` | A view as text lines: one per card, group, note, reference, collection, edge and arrow (`viewLines`, `view --compact`) |
| | `view-schema.ts`, `diagram-schema.ts`, `shapes-schema.ts`, `view-ui.ts` | Diagram projection of a view, gesture data |
| | `explorer.ts`, `outline.ts`, `properties.ts`, `validation.ts` | Panel row types and the explorer drag payload |
| | `fuzzy.ts` | Ordered-character matching, match positions and ranking |
| | `labels.ts`, `search.ts`, `paths.ts`, `selection.ts`, `prompts.ts` | Labels (`pickLabel`: the one label rule, in the workspace language), Find Element hits, portable paths, selection by kind, dialog and picker content |
| | `markdown.ts` | View embeds in Markdown documents and the plan of a Markdown export |
| | `notation.ts`, `notation-graph.ts`, `notation-join.ts`, `notation-schema.ts`, `sha256.ts` | Notation engine (ADR 0014): figures, join, removal, arrival; SHACL and value-set elements of the diagram |
| `packages/rdf-serialization/src` | `index.js`, `browser/triplify.js`, `serializers/`, `utils.js` | Serializer exports, browser-safe TriG path, RDF 1.2 term helpers |
| `packages/rdf-files/src` | `store.ts`, `oxigraph-store.ts`, `wasm-memory.ts`, `trap.ts`, `terms.ts` | Quad store port, Oxigraph store, the size of its WebAssembly memory (the trace notes it at each change), the trap guard (a WebAssembly trap stops the store; ModelStore then reads the files again, manifest §3.4), term keys |
| | `formats.ts`, `listing.ts`, `paths.ts`, `text-patch.ts` | Formats, canonical write, file listing, text patches of Turtle and of a TriG graph block, statement positions |
| | `file-sync.ts`, `git.ts` | File queue, folder watch, atomic writes, Git status and commits |
| `packages/rdf-core/src` | `graph.ts` | ModelGraph: the store, the graph roles, generic reads, SPARQL in the logical data scope, transactions with their patch log, undo, redo and the change event. It imports only `terms.ts` (`scripts/check-boundaries.mjs`). The constructor takes the graph rules (view test, view graphs, metamodel test, cache dependencies of a quad, layout-only test of a patch) and the graph names (`GraphNames`: union, report, data, shapes, fileOf). The type parameter `P` types `proposed`. |
| | `history.ts` | Undo and redo stacks and the patch queue. History records final file graphs, including transfers. The type parameter `C` types a queued change. |
| | `skolem.ts`, `terms.ts`, `plain-quads.ts` | Blank-node replacement with the contract prefix `urn:skolem:` (`skolemizer(base)` for another prefix); the rdf-ext factory, `TermJSON` and `jsonToTerm`; quads as plain values for the validation worker |
| `packages/rdf/src` | `model-store.ts` | Store coordination, shared patch events, undo and redo through `History` of rdf-core. ModelStore exposes PanelReads for query dispatch and wires file operations through ports. |
| | `graph.ts` | The Catenary ModelGraph: `ModelGraph<Proposal>` of rdf-core, where a proposal is a data migration of a shape edit. Re-exports the graph names of `graph-names.ts`. |
| | `graph-names.ts` | The Catenary graph names that rdf-core does not own: `UNION_GRAPH`, `REPORT_GRAPH`, the data and shapes graph prefixes and helpers, `CATENARY_GRAPH_NAMES`. |
| | `model-graph.ts` | `newModelGraph(store)`: a ModelGraph with the rules of `views.ts`, `vocabulary.ts` and `change.ts` and the graph names of `graph-names.ts`. Construct a ModelGraph through it. |
| | `views.ts`, `vocabulary.ts` | Functions of a ModelGraph. `views.ts` imports `vocabulary.ts`, not the reverse. Views: the view vocabulary `V`, views, placements, connectors, marks and their IRIs. Vocabulary: the predicates `P`, SKOS and RDFS tests, `metamodelQuad`, instances, labels, IRIs in use and minting. |
| | `change.ts` | The change pipeline (manifest §11.3): one patch to its tier, scope, cache keys, validation decision and affected canvases (`classify`, `tierOf`, `refreshes`, `keepsReads`, `validates`); the merge of a data change into the kept part of a canvas (`mergeRecords`). ModelGraph (through the rules of `model-graph.ts`), ModelStore, ViewState and the snapshot call it. `REPORT_GRAPH` comes from `graph-names.ts`. |
| | `panel-reads.ts`, `read-context.ts` | Frontend query host: request-scoped reads, panel rules and prompt data. RPC and CLI dispatch queries here. ModelStore retains event-keyed caches. Read-context keeps the facts that several reads share (shaped classes, property shape terms, files, placements, instance tests) on the data event: a read of n elements asks the store a bounded number of times (manifest §11.3 law_readQueriesBounded). |
| | `settings.ts`, `files.ts`, `trig.ts` | Workspace settings, file membership, imported globs, statement positions, file reference paths and disk state, RDF serialization |
| | `loader.ts`, `reconciler.ts`, `placement.ts`, `saver.ts`, `validation-data.ts` | Sync modules. Loader resolves open targets and reads workspace, model and import files. Reconciler owns the watcher, own-write filtering and disk reads. Placement assigns file graphs. Saver holds dirty state and import copies. Writer queues writes, and commits the written files 60 s after the last content edit, at a save, at dispose and at an open, with a message from the pending record (kinds with counts, views). A failed commit keeps the record for the next commit. Validation-data owns open editors, validation input, result IDs and the checked-instance count. None imports another. ModelStore wires them through ports. |
| | `import.ts` | Import orchestration: prefix merge, marks, copies and rollback through ports. ModelStore supplies the file queue. No sync module imports another. |
| | `ids.ts`, `terms.ts`, `moved-ids.ts` | Identity, the terms of rdf-core with the writer prefixes, IDs that a change replaced |
| | `commands.ts`, `ops.ts`, `elements.ts`, `shape-ops.ts`, `figure-edits.ts` | Command dispatch and edit effects; removal, arrival and data arrival of figures (ADR 0014) |
| | `clipboard.ts` | RDF clipboard parsing, additive insertion, notation placement, paste layout and selected RDF export |
| | `sparql.ts`, `queries.ts`, `records.ts`, `view-read.ts`, `scoped-doc.ts`, `selection.ts` | Shared SPARQL rules and scoped read models. Queries reads predicates, classes, view descriptions and applicability. Selection reads element statements, source files and text targets. |
| | `explorer.ts` | Model explorer host: plugins, the query port over the graphs of one file, keys, pages, search and paths. The Related providers of the Links tab |
| | `outline.ts`, `properties.ts`, `search.ts`, `actions.ts`, `link-choices.ts` | Panel and action queries. Link-choices also reads shape target choices. `queries.ts` reads hidden-edge membership and labels without constructing cards. |
| | `shapes.ts`, `shapes-read.ts`, `shape-proposal.ts`, `shacl-targets.ts` | Shapes dataset and SKOS vocabulary of the metamodel, the shapes quads of a ModelGraph (`shapesQuads`, `shapesTarget`, `vocabularyQuads`), form shapes, shapes index, shape proposal and the shared SHACL query adapter. The adapter keeps the target matches of each node and drops those that a data patch can change (manifest §11.3). |
| | `authoring.ts` | The plugins of the palette, links and fields contracts on the store: ports and merge |
| | `validate.ts`, `validation-runner.ts`, `validation-worker.ts`, `report-read.ts` | The pure validator (data and shape quads in, a report out); ValidationRunner debounces runs, rejects stale results and writes the report graph through the shared patch path; the report read of Problems and Properties |
| | `trace.ts` | Trace spans with causes (AsyncLocalStorage), totals, quad-store query reporting; `figure-edits.ts` traces sync, derivation and placement rules; `view-read.ts` and `model-store.ts` trace full-view reads and instance file origins; `modeler/src/node/glsp/view-session.ts` traces the steps of a canvas refresh (layout patch, hidden neighbors, figures, applicability, schema, graph model) |
| | `notations.ts`, `../notations/*.ttl` | Built-in notations, the SHACL package asset and notation-engine input. `storeInput` reads the store on demand around one view, `keptStoreInput` keeps what it read and forgets the terms of each patch, and `viewFiguresOf` derives the figures of a view from its placed terms. The bundle copies all assets. |
| `modeler/src/common` | `protocol.ts`, `cli-protocol.ts`, `cli-protocol.json` | RPC (with the Markdown export) and CLI contracts, CLI protocol version |
| `modeler/src/node` | `model-service.ts`, `cli-endpoint.ts`, `cli-token-validator.ts` | RPC service, CLI endpoint |
| | `markdown-export.ts` | Markdown export files: the root of the sources and their documents, link targets, destination checks, owned writes |
| | `glsp/` | GLSP server, one session per view (`view-session.ts`: the kept part of the view, layout patches and data patches in place by the tier of change.ts, hidden canvases; `ViewSession.edit`: the one edit path and its one warning, ui-manifest §4.9), operation handlers, layout |
| `modeler/src/browser` | `actions.ts`, `action-service.ts`, `action-commands.ts`, `action-menus.ts`, `follow-up.ts` | Actions, prompts, creation follow-up |
| | `selection-model.ts`, `model-client.ts`, `commands.ts` (workspace commands and file presentation opener), `menus.ts`, `outline.ts`, `problems.ts`, `side-panel-sizes.ts` | Window state and shell integration |
| | `insert-view.ts` | Insert View in a Markdown editor |
| | `diagram/`, `notes/` | Canvas rendering, gestures, clipboard, notes. `diagram/markdown-export.ts`: Markdown export flow and SVG rendering of views. `diagram/export-zoom.ts`: the export renders the geometry at zoom 1 and the sizes that are constant on screen at the canvas zoom of the view. `diagram/markdown-export-dialog.tsx`: confirmation dialog of the export (destination, document tree with checkboxes, counts). `notes/view-notes.tsx`: exclusive Properties/native Markdown editing and autosave. `notes/view-notes-resource.ts`: virtual Markdown resource backed by the view graph. `pending-*.ts`: moves and new members shown before the server confirms them. `diagram/selection-sync.ts`, `diagram/diagram-ids.ts`: the one window selection (a select on the origin canvas only, modifier clicks and keys on a highlight). `diagram/canvas-highlight.ts`: the local highlight of a canvas that is not the origin. `diagram/cut-mark.ts`, `diagram/cut-mark-canvas.ts`: the cut mark of the window (dimmed placements, Escape, paste messages). `diagram/after-revision.ts`: the wait of a reveal for the update of a show |
| | `trace/` | Trace panel (bottom area), request round trips and `visible-update-trace.ts` (model input to a paint opportunity) |
| | `explorer/`, `properties/`, `prefixes/` | Panels and Workspace settings. `explorer/model-explorer.tsx`: file Model documents, pages, the flat fuzzy filter and folder drags. |
| | `rdf-language*.ts`, `cli-bridge.ts`, `file-kinds-decorator.ts` | Text highlighting, CLI window adapter, file navigator labels |
| `scripts` | `esbuild-catenary.mjs`, `dev-workspace.sh`, `start-browser.sh`, `desktop.sh`, `verify.mjs`, `e2e.cjs`, `catenary.mjs`, `check-boundaries.mjs`, `check-manifests.mjs` | Build, example workspace setup, hosts, verification, browser tests, CLI, import rules, manifest typecheck |
| | `e2e/harness.cjs` | Browser tests: registration and selection (`E2E_LIST`, `E2E_TEST`), fixtures, CLI, backend and browser lifetime, `waitUntil`, failure diagnostics |
| | `e2e/rendering.cjs`, `e2e/clipboard-shapes.cjs`, `e2e/editors.cjs`, `e2e/panels-canvas.cjs` | Browser scenarios: rendering without a backend; clipboard and shapes view; editors and persistence; panels and canvases |
| | `check-windows-package.mjs`, `smoke-desktop.mjs` | Static check of the Windows package (`scripts/package.sh win32-x64`), desktop smoke test of the build or a Linux, Windows or macOS package |
| | `smoke-cli.mjs`, `check-links.mjs`, `check-css.mjs` | CI: CLI and RPC contract smoke test, Markdown links, style sheets |
| | `rdf-query.cjs` | SPARQL on RDF files (Oxigraph) for tests and agents |
| | `gen-command-schema.mjs` | `pnpm gen:schema`: writes `packages/model/src/command-schema.json`; `--check` (in `pnpm check`) refuses a stale file |

## Hosts

- **Browser app** (`app/`): Theia backend and frontend on `http://localhost:3100`. The e2e tests and the CLI checks use it.
- **Electron app** (`electron-app/`): the same Theia packages and extension in one desktop process. One process serves one profile and holds one `ModelStore`. `scripts/desktop.sh` gives each workspace its own profile in `~/.config/catenary/profiles/<hash>`, so each workspace runs in its own process. A request for a second window (New Window, a workspace opened in a new window, a second launch) starts a new process with the profile of its workspace. A request for the workspace of the running process focuses its window. Code: `modeler/src/electron-main/electron-main-module.ts`.
- Both start the Theia plugin host with the VS Code Git extensions (`--plugins=local-dir:plugins`) for Source Control. Run, Debug and Testing contributions are hidden.

## Persistence

- Each edit, undo and redo queues a write. The queue runs file operations one at a time.
- A Turtle file gets a text patch: only the blocks of the changed subjects change. Catenary parses the result again and compares it with the expected RDF before it accepts it.
- A TriG view file (one graph block) gets the same text patch inside its graph block. The prefixes, comments and the other blocks stay byte for byte. The comparison checks the graph of each statement. The saver keeps the net changes of each view since its last write. The patch gets these changes (`patchTurtleDiff`) and does not compare two full statement sets. The saver reads them from the statements captured at the save, not from the live store. An edit during the disk read thus keeps the text patch. A second graph block, or a statement outside the block, gives a whole-file write.
- Other formats and failed patches get a whole-file write: for Turtle first in the style of the file, then with the canonical writer as fallback.
- Writes go to temporary files, then rename. Cross-file rollback is not required. A partial-save failure must report its cause and keep unwritten changes pending for retry (open check STORE2).
- Catenary refuses to overwrite a file whose disk text differs from its last read or write.
- The watcher reads changed files 150 ms after the last event. It does not read when each event is a file that Catenary wrote and that is unchanged since. A read from disk clears the undo history.

## Testing

Vitest loads the TypeScript source, not `lib/`: `vitest.aliases.mts` maps each workspace package to its source entry. Keep each test at the lowest layer that detects the failure.

| Layer | Tests |
|---|---|
| `packages/model/test` | Pure rules: labels, selection, diagram rules, geometry |
| `packages/rdf-serialization/test` | Canonicalization and Turtle/TriG serialization |
| `packages/rdf-files/test` | Formats, listing, disk changes, atomic writes, watch, Git |
| `packages/rdf-core/test` | Undo and redo stacks and the patch queue |
| `packages/rdf/test` | RDF commands, transactions, undo, queries, validation, file round trips |
| `packages/rdf/test/perf` | Elapsed time against `readBudgetMs` (`pnpm test:perf` only) |
| `modeler/test` | Store-to-GLSP updates, frontend actions, selection, layout |
| `scripts/e2e.cjs`, `scripts/e2e/` | Browser wiring of gestures and rendering only |
| `scripts/smoke-cli.mjs` | CLI and RPC contract of the browser backend: authentication, edits on disk, undo, read back, `--workspace` selection |
| `scripts/smoke-desktop.mjs` | The desktop app or a package: paths, writes, Git, watcher, plugins, native modules |

Path rules take the platform as a parameter (`path.win32` or `path.posix`), so the tests check the Windows rules on Linux. The Windows workflow runs the same tests on Windows.

Laws: a test that checks a manifest law cites the law name (`law_<name>`) in its test name or in a comment next to the check. To find the check of a law, search the tests for its name. Tests of the change pipeline, the selection and the store failure:

| Test | Laws |
|---|---|
| `packages/rdf/test/change.test.ts`, `modeler/test/view-session.test.ts` | `law_keptDocEqualsRead`, `law_canvasEditErrorsOnce`, `law_revealAfterShowUpdate`, `law_clientGetsNoOlderModel` |
| `packages/rdf/test/read-budget.test.ts`, `packages/rdf/test/shacl-targets.test.ts` | `law_keptReadsEqualRead`, `readBudgetMs` |
| `packages/rdf/test/selection-scale.test.ts`, `packages/rdf/test/explorer.test.ts` | `readBudgetMs`: the store reads of a panel read of a few hundred placements stay bounded |
| `packages/rdf/test/perf/*.perf.ts` | `readBudgetMs`: elapsed time of the same reads (`pnpm test:perf`) |
| `packages/rdf/test/store.test.ts`, `packages/rdf-files/test/trap.test.ts` | `law_trapReadsFilesOnce`, `law_trapStopsStoreCalls` |
| `packages/rdf-files/test/text-patch.test.ts`, `packages/rdf/test/review-save.test.ts` | `law_graphPatchKeepsText` |
| `packages/rdf/test/explorer.test.ts`, `packages/rdf/test/file-explorer.test.ts` | `law_fileRowsOwnSubjects` |
| `packages/shacl/test/related.test.ts` | `law_sameTargetClass` |
| `modeler/test/selection-sync.test.ts`, `modeler/test/diagram-ids.test.ts`, `modeler/test/selection-model.test.ts` | `law_oneSelectionPerWindow`, `law_highlightKeys`, `law_selectionReadsLastOnly` |
| `modeler/test/after-revision.test.ts` | `law_revealAfterShowUpdate` |
| `modeler/test/action-service.test.ts` | `law_selectionReadsLastOnly`, `law_gestureNoQuietWait`, `law_disabledGestureShowsReason` |
| `packages/model/test/actions.test.ts` | `law_disabledGestureShowsReason` (`gestureStep`) |
| `scripts/e2e/panels-canvas.cjs`, `scripts/e2e/editors.cjs` | `law_oneSelectionPerWindow` and `law_highlightKeys` (two canvases side by side), `law_hiddenCanvasRefreshesOnce` (panel reads), `law_revealAfterShowUpdate` and `law_gestureNoQuietWait` (file presentations), `law_disabledGestureShowsReason` (predicate click, F12), `law_gatheredRowPerStatement` (card line tooltip, hit target, drag) |

Read budget: `packages/rdf/test/scale-fixtures.ts` generates the scale fixtures: a view of 600 cards, a view of 300 placed instances and an explorer file of 600 subjects. Each open writes a new temporary workspace, so a test that edits owns its fixture. The functional tests assert no elapsed time. `read-budget.test.ts` checks that each panel read of 600 elements and each step of a content change is one tracer span, and that the kept reads equal the reads of a new store after each edit, undo and redo. `selection-scale.test.ts` and `explorer.test.ts` bound the SPARQL queries and store reads.

Performance: `pnpm test:perf` (`vitest.perf.config.mts`) runs `packages/*/test/perf/*.perf.ts`, one file at a time in one process. `pnpm verify` and CI do not run it. Each step has 2 unmeasured warm-up runs and 20 samples. Its p50 must keep `readBudgetMs` (manifest §11.3) or the ceiling of its exception. The exceptions are listed in `perf/read-budget.perf.ts` with their `spec/open.md` row. Each file writes a JSON report to `CATENARY_PERF_DIR` (default: `catenary-perf` in the temporary directory): the samples, p50 and maximum of each step, the Node version, the fixture size and the environment kind (diagnostic or controlled). The tracer spans measure elapsed time, which includes the time that the thread waits for a CPU. A run is diagnostic, and an overrun is inconclusive, unless `CATENARY_PERF_ENV` describes a controlled environment. Do not run other builds or tests on the same CPUs during a measurement.

Test oracles: `packages/rdf/test/project-full.ts` (read model of the whole dataset) and `packages/model/test/doc-reference.ts`. The application uses neither. `scoped-doc.test.ts` compares the store answers with them. An oracle reads the whole dataset: compute it once before a loop, not in a loop or in an assertion message.

Isolation: each test file has its own module graph (`vitest.config.mts`). Do not disable isolation to make the suite faster. After each test, Vitest restores mocks, spies, stubbed globals (`vi.stubGlobal`) and stubbed environment variables (`vi.stubEnv`). `vitest.setup.ts` then resets the prefix table and the timer mode. A file that shares one store across its tests sets the prefixes of that store again before each test (`notation-engine.test.ts`).

Cleanup: a test that edits gets a new fixture. Only a fixture that no test changes can be shared (`beforeAll`). Dispose each store with `await store.dispose()` before you remove its directory. Wait for a completion point: an operation promise, a deferred promise that the test resolves, or a predicate (`vi.waitFor`). Do not wait for a fixed delay or a zero-delay timer.

Time: fake timers control only the timer APIs of their context. They do not make file system events, worker messages, network traffic or another process synchronous, and a browser clock does not control the backend clock. To test a debounce or timeout, advance time to one millisecond before the deadline and to the deadline, and check cancellation and disposal before expiry. Register a completion listener before you start the work, and correlate it with the operation or revision under test. Before a negative assertion ("nothing changed"), confirm that the work finished: drain the controlled scheduler, or in a browser test wait for the acknowledgement and the revision. Poll only observable integration state, against a monotonic deadline, and put the last observed state in the timeout error.

Validation worker: `vitest.global-setup.mts` bundles `packages/rdf/src/validation-worker.ts` from source into a new temporary directory before the tests. `validation-runner.test.ts` runs a real worker thread from that file (`inject('validationWorker')`) and stops it with `stopValidationWorker()` after the test. No test reads `packages/rdf/lib`. The failure, exit and stale-reply cases use a fake worker (`WorkerLike`).

Change the store through `ModelGraph.add` and `remove`. Transactions publish one scoped event. Rejected transactions publish none. Loads, unloads and reports use the same path. Cache keys retain the last relevant event.

### CI

`.github/workflows/ci.yml` runs the same jobs for each pull request and each push to `main`. The only required check is `gate`.

| Job | Steps | When |
|---|---|---|
| `test` | `pnpm check`, `pnpm test` | Always |
| `app` | `pnpm build:browser`, `scripts/smoke-cli.mjs`, `pnpm e2e` | Always |
| `windows` | `windows.yml`: Windows tests, Electron build, Linux and Windows packages | Nightly, manual run, PR with the label `ci:full` |

- Add the label `ci:full` to a change of dependencies, Electron or packaging.
- A tag `v*` runs only `release.yml`. It requires a passed CI run on `main` for the commit, then builds the packages once and starts each one. After a change of `release.yml` or `scripts/package.sh`, run the Release workflow manually: it builds and starts the packages without a release.

Assert fields and geometry invariants, not whole-render snapshots or exact ELK coordinates. Query RDF results with SPARQL (`scripts/rdf-query.cjs`), including named graphs. Never run tests against `workspace/`.
