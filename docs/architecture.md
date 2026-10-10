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
4. Write: the file queue writes the patch to the files that hold the statements, as a Turtle text patch when possible, else as a whole file. Then it makes a Git commit of those files.
5. Notify: each patch produces one event with its changed graphs and elements. Caches retain the last event that affects their input. Connections receive snapshots with event sequence numbers, file state and change scope. A panel or view session reads again only when the scope touches it.
6. Validate: 250 ms after a data or shape change, SHACL runs in a worker thread. The report goes to the unsaved graph `urn:trellis:validation`.

## Store layout

| Graph | Content |
|---|---|
| `<view IRI>` | The statements of one view file. |
| `urn:shapes:<encoded path>` | Shape subjects and their nested nodes, per source file. |
| `urn:data:<encoded path>` | Other statements, per source file. |
| `urn:trellis:validation` | The SHACL report. Not saved, not in undo, not in the dirty check. |

Model-file reads preserve SPO statements and source-file provenance, not source graph names. Catenary assigns the store graphs above instead. View files retain their required view graph IRI. Writes do not restore source graph names.

Data reads use a union of the file data graphs with duplicate triples removed. `ModelGraph.model` is this logical scope. Commands assign final file graphs before they commit. History stores only quad patches and the migration queue. Canonical file content determines dirty state. Touched graphs invalidate only their file cache entries.

The workspace file (`workspace.trig`, graph `urn:name:workspace`) stays in workspace metadata, outside the store graphs above. The `urn:trellis:list:*` identifiers remain because saved view files use them.

## Packages

Imports flow from `modeler` to `@catenary/rdf` and `@catenary/model`. `@catenary/model` imports `@catenary/explorer`, `@catenary/palette`, `@catenary/links`, `@catenary/fields` and `@catenary/shacl/common`. `@catenary/shacl` and `@catenary/rdfs` import only the contracts: `@catenary/query`, `@catenary/explorer`, `@catenary/palette`, `@catenary/links` and `@catenary/fields`. Each contract imports only `@catenary/query`. `@catenary/rdf` imports `@catenary/shacl/backend`, `@catenary/rdfs`, the contracts, `@catenary/model`, `rdf-files` and `rdf-serialization`. `rdf-files` imports `rdf-serialization`. `scripts/check-boundaries.mjs` rejects other imports.

| Package | Responsibility | Allowed dependencies |
|---|---|---|
| `packages/query` (`@catenary/query`) | The query port that a host gives to a vocabulary package: SPARQL SELECT, graph patterns, labels. The namespaces and the IRI escaper of the queries. | None. |
| `packages/explorer` (`@catenary/explorer`) | The contract of the Model explorer: sections, rows, paths, the explorer port. | `@catenary/query`. |
| `packages/palette` (`@catenary/palette`) | The contract of the palette and the class picker: classes, with name, description and order. | `@catenary/query`. |
| `packages/links` (`@catenary/links`) | The contract of the link picker and of drawn and reconnected edges: links (class, predicate, target class, cardinality). | `@catenary/query`. |
| `packages/fields` (`@catenary/fields`) | The contract of the Properties form and the card fields: fields (class, predicate, datatype or values, cardinality). | `@catenary/query`. |
| `packages/shacl` (`@catenary/shacl`) | The SHACL plugin: the Shapes section of the Model explorer; the palette classes, links and fields of the shapes. Also SHACL target types, applicability queries, form predicates, connection rules and notation assets. | The contracts. Hosts supply query ports and graph identities. |
| `packages/rdfs` (`@catenary/rdfs`) | The RDFS plugin: the Classes section of the Model explorer (classes, subclasses and instances as written); the palette classes, links and fields of `rdfs:domain` and `rdfs:range`. | The contracts. |
| `packages/model` (`@catenary/model`) | JSON types, commands, query declarations, pure rules on read models, the merge of the plugins into the metamodel. Runs in Node and the browser. | `canonical-md`, `@catenary/explorer`, `@catenary/palette`, `@catenary/links`, `@catenary/fields`, `@catenary/shacl/common`. No RDF library, UI framework or Node built-in. |
| `packages/rdf-serialization` (`rdf-serialization`) | Vendored RDF canonicalization and Turtle/TriG serialization. Exports ESM and CommonJS. | RDF libraries, Node built-ins. No Catenary package. |
| `packages/rdf-files` | Generic RDF files and quad store: formats, canonical write, Turtle text patches, folder watch, atomic writes, Git, Oxigraph store. Usable outside Catenary. | `rdf-serialization`, RDF libraries, Node built-ins. No `@catenary/*`. |
| `packages/rdf` (`@catenary/rdf`) | `ModelStore`: operations, queries, validation, persistence. Runs the plugins; parses no vocabulary for the metamodel. Node only. | `@catenary/shacl`, `@catenary/rdfs`, the contracts, `@catenary/model`, `rdf-files`, `rdf-serialization`, RDF libraries, Node built-ins. No Theia, GLSP, React or DOM. |
| `modeler` | Theia extension: RPC service, GLSP adapters, panels, canvas. | `@catenary/model`. Only `src/node` imports `@catenary/rdf`. |
| `app`, `electron-app` | Browser host and desktop host. | Theia packages and `modeler`. |

Values that cross a package boundary are JSON, including RDF terms and IDs.

### Add a Model explorer section

1. Implement `ExplorerPlugin` (`packages/explorer/src/index.ts`) in the package of the vocabulary. Query only through the `ExplorerPort`.
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

1. Implement the contracts that the vocabulary can give in its package: `PaletteProvider` (`packages/palette`), `LinksProvider` (`packages/links`), `FieldsProvider` (`packages/fields`), `ExplorerPlugin` (`packages/explorer`). Query only through the port.
2. Add it to `AUTHORING_PLUGINS` (`packages/rdf/src/authoring.ts`) with the graphs it reads, and its explorer plugin to `EXPLORER_PLUGINS` (`packages/rdf/src/explorer.ts`). The order of `AUTHORING_PLUGINS` is the precedence: for a class and a predicate, the first plugin that gives a link or a field wins.

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
| `packages/query/src` | `index.ts` | Query port, namespaces and the IRI escaper |
| `packages/explorer/src` | `index.ts` | Model explorer contract |
| `packages/palette/src`, `packages/links/src`, `packages/fields/src` | `index.ts` | Palette, links and fields contracts |
| `packages/shacl/src` | `common/index.ts`, `backend/targets.ts`, `backend/node.ts`, `backend/form.ts` | Target declarations, query ports, direct targeting, node constraints, form predicates and connection rules |
| | `backend/explorer.ts` | Shapes section of the Model explorer |
| | `backend/authoring.ts` | Palette classes, links and fields of the shapes |
| `packages/rdfs/src` | `explorer.ts` | Classes section of the Model explorer |
| | `domain-range.ts` | Palette classes, links and fields of `rdfs:domain` and `rdfs:range` |
| `packages/shacl/notations` | `shapes.ttl` | SHACL figure definitions |
| `packages/model/src` | `doc.ts`, `terms.ts`, `ids.ts`, `snapshot.ts`, `trace.ts`, `trace-metrics.ts` | Read-model records, JSON terms, element IDs, snapshot schema, trace records and metric calculations |
| | `commands.ts`, `actions.ts`, `queries.ts` | Edit commands, action applicability, read-query declarations |
| | `paste-layout.ts` | Packs new placements around fixed boxes and moves copied frames with their contents |
| | `metamodel.ts`, `shapes-doc.ts`, `form.ts` | Shapes, ranges, the merge of the plugins, prefixes, form conversion |
| | `view-schema.ts`, `diagram-schema.ts`, `shapes-schema.ts`, `view-ui.ts` | Diagram projection of a view, gesture data |
| | `explorer.ts`, `outline.ts`, `properties.ts`, `validation.ts` | Panel row types and the explorer drag payload |
| | `fuzzy.ts` | Ordered-character matching, match positions and ranking |
| | `labels.ts`, `search.ts`, `paths.ts`, `selection.ts`, `prompts.ts` | Labels, Find Element hits, portable paths, selection by kind, dialog and picker content |
| | `markdown.ts` | View embeds in Markdown documents and the plan of a Markdown export |
| | `notation.ts`, `notation-graph.ts`, `notation-join.ts`, `notation-schema.ts`, `sha256.ts` | Notation engine (ADR 0014): figures, join, removal, arrival; SHACL and value-set elements of the diagram |
| `packages/rdf-serialization/src` | `index.js`, `browser/triplify.js`, `serializers/`, `utils.js` | Serializer exports, browser-safe TriG path, RDF 1.2 term helpers |
| `packages/rdf-files/src` | `store.ts`, `oxigraph-store.ts`, `terms.ts` | Quad store port, Oxigraph store, term keys |
| | `formats.ts`, `listing.ts`, `paths.ts`, `text-patch.ts` | Formats, canonical write, file listing, Turtle text patches and statement positions |
| | `file-sync.ts`, `git.ts` | File queue, folder watch, atomic writes, Git status and commits |
| `packages/rdf/src` | `model-store.ts`, `graph.ts`, `history.ts` | Store coordination, transactions, shared patch events, undo and redo. ModelStore exposes PanelReads for query dispatch and wires file operations through ports. History records final file graphs, including transfers. |
| | `panel-reads.ts` | Frontend query host: request-scoped reads, panel rules and prompt data. RPC and CLI dispatch queries here. ModelStore retains event-keyed caches. |
| | `settings.ts`, `files.ts`, `trig.ts` | Workspace settings, file membership, imported globs, statement positions, file reference paths and disk state, RDF serialization |
| | `loader.ts`, `reconciler.ts`, `placement.ts`, `saver.ts`, `validation-data.ts` | Sync modules. Loader resolves open targets and reads workspace, model and import files. Reconciler owns the watcher, own-write filtering and disk reads. Placement assigns file graphs. Saver holds dirty state and import copies. Writer queues writes and commits, retaining retry notes across opens. Validation-data owns open editors, validation input, result IDs and the checked-instance count. None imports another. ModelStore wires them through ports. |
| | `import.ts` | Import orchestration: prefix merge, marks, copies and rollback through ports. ModelStore supplies the file queue. No sync module imports another. |
| | `skolem.ts`, `ids.ts`, `terms.ts`, `moved-ids.ts` | Blank-node replacement, identity, IDs that a change replaced |
| | `commands.ts`, `ops.ts`, `elements.ts`, `shape-ops.ts`, `figure-edits.ts` | Command dispatch and edit effects; removal, arrival and data arrival of figures (ADR 0014) |
| | `clipboard.ts` | RDF clipboard parsing, additive insertion, notation placement, paste layout and selected RDF export |
| | `sparql.ts`, `queries.ts`, `records.ts`, `view-read.ts`, `scoped-doc.ts`, `selection.ts` | Shared SPARQL rules and scoped read models. Queries reads predicates, classes, view descriptions and applicability. Selection reads element statements, source files and text targets. |
| | `explorer.ts` | Model explorer host: plugins, query port, file scopes, keys, pages, search and paths |
| | `outline.ts`, `properties.ts`, `search.ts`, `actions.ts`, `link-choices.ts` | Panel and action queries. Link-choices also reads shape target choices. `queries.ts` reads hidden-edge membership and labels without constructing cards. |
| | `shapes.ts`, `shapes-read.ts`, `shape-proposal.ts`, `shacl-targets.ts` | Shapes dataset and SKOS vocabulary of the metamodel, form shapes, shapes index, shape proposal and the shared SHACL query adapter |
| | `authoring.ts` | The plugins of the palette, links and fields contracts on the store: ports and merge |
| | `validate.ts`, `validation-runner.ts`, `validation-worker.ts`, `plain-quads.ts`, `report-read.ts` | The pure validator (data and shape quads in, a report out); ValidationRunner debounces runs, rejects stale results and writes the report graph through the shared patch path; the report read of Problems and Properties |
| | `trace.ts` | Trace spans with causes (AsyncLocalStorage), totals, quad-store query reporting; `figure-edits.ts` traces sync, derivation and placement rules; `view-read.ts` and `model-store.ts` trace full-view reads and instance file origins; `modeler/src/node/glsp/view-session.ts` traces the steps of a canvas refresh (layout patch, hidden neighbors, figures, applicability, schema, graph model) |
| | `notations.ts`, `../notations/*.ttl` | Built-in notations, the SHACL package asset and notation-engine input. `storeInput` reads the store on demand around one view, and `viewFiguresOf` derives the figures of a view from its placed terms. The bundle copies all assets. |
| `modeler/src/common` | `protocol.ts`, `cli-protocol.ts` | RPC (with the Markdown export) and CLI contracts |
| `modeler/src/node` | `model-service.ts`, `cli-endpoint.ts`, `cli-token-validator.ts` | RPC service, CLI endpoint |
| | `markdown-export.ts` | Markdown export files: documents of the source folder, link targets, destination checks, owned writes |
| | `glsp/` | GLSP server, one session per view (`view-session.ts`: the kept part of the view, layout patches in place, hidden canvases), operation handlers, layout |
| `modeler/src/browser` | `actions.ts`, `action-service.ts`, `action-commands.ts`, `action-menus.ts`, `follow-up.ts` | Actions, prompts, creation follow-up |
| | `selection-model.ts`, `model-client.ts`, `commands.ts` (workspace commands and file presentation opener), `menus.ts`, `outline.ts`, `problems.ts`, `side-panel-sizes.ts` | Window state and shell integration |
| | `insert-view.ts` | Insert View in a Markdown editor |
| | `diagram/`, `notes/` | Canvas rendering, gestures, clipboard, notes. `diagram/markdown-export.ts`: Markdown export dialog and SVG rendering of views. `notes/view-notes.tsx`: exclusive Properties/native Markdown editing and autosave. `notes/view-notes-resource.ts`: virtual Markdown resource backed by the view graph. `pending-*.ts`: moves and new members shown before the server confirms them |
| | `trace/` | Trace panel (bottom area), request round trips and `visible-update-trace.ts` (model input to a paint opportunity) |
| | `explorer/`, `properties/`, `prefixes/` | Panels and Workspace settings. `explorer/model-explorer.tsx`: file Model documents, pages, the flat fuzzy filter and folder drags. |
| | `rdf-language*.ts`, `cli-bridge.ts`, `file-kinds-decorator.ts` | Text highlighting, CLI window adapter, file navigator labels |
| `scripts` | `esbuild-catenary.mjs`, `dev-workspace.sh`, `start-browser.sh`, `desktop.sh`, `verify.mjs`, `e2e.cjs`, `catenary.mjs`, `check-boundaries.mjs`, `check-manifests.mjs` | Build, example workspace setup, hosts, verification, browser tests, CLI, import rules, manifest typecheck |
| | `check-windows-package.mjs`, `smoke-desktop.mjs` | Static check of the Windows package (`scripts/package.sh win32-x64`), desktop smoke test of the build or a Linux, Windows or macOS package |
| | `smoke-cli.mjs`, `check-links.mjs`, `check-css.mjs` | CI: CLI and RPC contract smoke test, Markdown links, style sheets |
| | `rdf-query.cjs` | SPARQL on RDF files (Oxigraph) for tests and agents |

## Hosts

- **Browser app** (`app/`): Theia backend and frontend on `http://localhost:3100`. The e2e tests and the CLI checks use it.
- **Electron app** (`electron-app/`): the same Theia packages and extension in one desktop process. One process serves one profile and holds one `ModelStore`. `scripts/desktop.sh` gives each workspace its own profile in `~/.config/catenary/profiles/<hash>`, so each workspace runs in its own process. A request for a second window (New Window, a workspace opened in a new window, a second launch) starts a new process with the profile of its workspace. A request for the workspace of the running process focuses its window. Code: `modeler/src/electron-main/electron-main-module.ts`.
- Both start the Theia plugin host with the VS Code Git extensions (`--plugins=local-dir:plugins`) for Source Control. Run, Debug and Testing contributions are hidden.

## Persistence

- Each edit, undo and redo queues a write. The queue runs file operations one at a time.
- A Turtle file gets a text patch: only the blocks of the changed subjects change. Catenary parses the result again and compares it with the expected RDF before it accepts it.
- Other formats, TriG view files and failed patches get a whole-file write: first in the style of the file, then with the canonical writer as fallback.
- Writes go to temporary files, then rename. Cross-file rollback is not required. A partial-save failure must report its cause and keep unwritten changes pending for retry (open check STORE2).
- Catenary refuses to overwrite a file whose disk text differs from its last read or write.
- The watcher reads changed files 150 ms after the last event. It does not read when each event is a file that Catenary wrote and that is unchanged since. A read from disk clears the undo history.

## Testing

Vitest loads the TypeScript source, not `lib/`. Keep each test at the lowest layer that detects the failure.

| Layer | Tests |
|---|---|
| `packages/model/test` | Pure rules: labels, selection, diagram rules, geometry |
| `packages/rdf-serialization/test` | Canonicalization and Turtle/TriG serialization |
| `packages/rdf-files/test` | Formats, listing, disk changes, atomic writes, watch, Git |
| `packages/rdf/test` | RDF commands, transactions, undo, queries, validation, file round trips |
| `modeler/test` | Store-to-GLSP updates, frontend actions, selection, layout |
| `scripts/e2e.cjs` | Browser wiring of gestures and rendering only |
| `scripts/smoke-cli.mjs` | CLI and RPC contract of the browser backend: authentication, edits on disk, undo, read back |
| `scripts/smoke-desktop.mjs` | The desktop app or a package: paths, writes, Git, watcher, plugins, native modules |

Path rules take the platform as a parameter (`path.win32` or `path.posix`), so the tests check the Windows rules on Linux. The Windows workflow runs the same tests on Windows.

Test oracles: `packages/rdf/test/project-full.ts` (read model of the whole dataset) and `packages/model/test/doc-reference.ts`. The application uses neither. `scoped-doc.test.ts` compares the store answers with them. An oracle reads the whole dataset: compute it once before a loop, not in a loop or in an assertion message.

The test files of a Vitest thread share one module graph (`vitest.config.mts`). `vitest.setup.ts` resets the process-wide state (the prefix table, fake timers) before each file. A file that calls `vi.mock` or `vi.spyOn` runs in a process of its own: the config finds these files. Change the store through `ModelGraph.add` and `remove`. Transactions publish one scoped event. Rejected transactions publish none. Loads, unloads and reports use the same path. Cache keys retain the last relevant event.

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
