# Architecture

This document describes the structure of the code and the flow of data. The exact contracts are in the [data contract](../spec/manifest.hs).

## Data flow

```text
 RDF files on disk  ──read / watch──▶  ModelStore (backend, one per workspace)
        ▲                               ├─ QuadStore on Oxigraph (in memory)
        │                               ├─ origin map: statement → source files
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

1. Open: the backend lists the model files, parses them, replaces blank nodes with skolem IRIs and loads the quads into the store. It records the source files of each statement.
2. Read: each panel and each view session asks the backend for what it shows. The backend answers with a SPARQL query, and builds a request-scoped read model when a rule needs one. No component holds a copy of the whole model.
3. Edit: the frontend or a GLSP handler sends one `EditCommand`. The store runs it in one synchronous transaction and produces one patch (added and removed quads) and one undo step.
4. Write: the file queue writes the patch to the files that hold the statements, as a Turtle text patch when possible, else as a whole file. Then it makes a Git commit of those files.
5. Notify: each connection receives a snapshot (revision, files, undo and dirty state, the scope of the last change). A panel or view session reads again only when the change scope touches it.
6. Validate: 250 ms after a data or shape change, SHACL runs in a worker thread. The report goes to the unsaved graph `urn:trellis:validation`.

## Store layout

| Graph | Content |
|---|---|
| `<view IRI>` | The statements of one view file. |
| `urn:file:<encoded path>` | Shape subjects and their nested nodes, per source file. |
| `urn:name:model` | All other statements. The origin map records the files of each statement. |
| `urn:trellis:validation` | The SHACL report. Not saved, not in undo, not in the dirty check. |

The workspace file (`workspace.trig`, graph `urn:name:workspace`) stays in workspace metadata, outside the store graphs above. The `urn:trellis:list:*` identifiers remain because saved view files use them.

## Packages

Imports flow from `modeler` to `@catenary/rdf` and `@catenary/model`. `@catenary/rdf` imports `@catenary/model`, `rdf-files` and `rdf-serialization`. `rdf-files` imports `rdf-serialization`. `scripts/check-boundaries.mjs` rejects other imports.

| Package | Responsibility | Allowed dependencies |
|---|---|---|
| `packages/model` (`@catenary/model`) | JSON types, commands, query declarations, pure rules on read models. Runs in Node and the browser. | `canonical-md` only. No RDF library, UI framework or Node built-in. |
| `packages/rdf-serialization` (`rdf-serialization`) | Vendored RDF canonicalization and Turtle/TriG serialization. Exports ESM and CommonJS. | RDF libraries, Node built-ins. No Catenary package. |
| `packages/rdf-files` | Generic RDF files and quad store: formats, canonical write, Turtle text patches, folder watch, atomic writes, Git, Oxigraph store. Usable outside Catenary. | `rdf-serialization`, RDF libraries, Node built-ins. No `@catenary/*`. |
| `packages/rdf` (`@catenary/rdf`) | `ModelStore`: operations, queries, validation, persistence. Node only. | `@catenary/model`, `rdf-files`, `rdf-serialization`, RDF libraries, Node built-ins. No Theia, GLSP, React or DOM. |
| `modeler` | Theia extension: RPC service, GLSP adapters, panels, canvas. | `@catenary/model`. Only `src/node` imports `@catenary/rdf`. |
| `app`, `electron-app` | Browser host and desktop host. | Theia packages and `modeler`. |

Values that cross a package boundary are JSON, including RDF terms and IDs.

### Add a read query for the frontend

1. Declare it in `ModelQueries` and `MODEL_QUERIES` (`packages/model/src/queries.ts`).
2. Implement it in `ModelStore`.
3. Call it as `service.<name>(…)` in the frontend.

The RPC service and `catenary rpc` take the query from `MODEL_QUERIES`. The compiler rejects a missing step. Do not edit `protocol.ts` or `model-service.ts` for a query.

## Code map

Paths are relative to the directory in the first column.

| Directory | Files | Purpose |
|---|---|---|
| `packages/model/src` | `doc.ts`, `terms.ts`, `ids.ts`, `snapshot.ts` | Read-model records, JSON terms, element IDs, snapshot schema |
| | `commands.ts`, `actions.ts`, `queries.ts` | Edit commands, action applicability, read-query declarations |
| | `metamodel.ts`, `shapes-doc.ts`, `form.ts` | Shapes, ranges, prefixes, form conversion |
| | `view-schema.ts`, `diagram-schema.ts`, `shapes-schema.ts`, `view-ui.ts` | Diagram projection of a view, gesture data |
| | `explorer.ts`, `outline.ts`, `properties.ts`, `validation.ts` | Panel row types |
| | `labels.ts`, `search.ts`, `paths.ts`, `selection.ts`, `prompts.ts` | Labels, search criteria, portable paths, selection by kind, dialog and picker content |
| | `notation.ts`, `notation-graph.ts`, `notation-join.ts`, `notation-schema.ts`, `sha256.ts` | Notation engine (ADR 0014): figures, join, removal, arrival; SHACL and value-set elements of the diagram |
| `packages/rdf-serialization/src` | `index.js`, `browser/triplify.js`, `serializers/`, `utils.js` | Serializer exports, browser-safe TriG path, RDF 1.2 term helpers |
| `packages/rdf-files/src` | `store.ts`, `oxigraph-store.ts`, `terms.ts` | Quad store port, Oxigraph store, term keys |
| | `formats.ts`, `listing.ts`, `paths.ts`, `text-patch.ts` | Formats, canonical write, file listing, Turtle text patches |
| | `file-sync.ts`, `git.ts` | File queue, folder watch, atomic writes, Git status and commits |
| `packages/rdf/src` | `model-store.ts`, `graph.ts`, `history.ts` | Store coordination, transactions, change events, undo and redo |
| | `workspace.ts`, `files.ts`, `placement.ts`, `trig.ts` | Workspace files, manifest, statement origin, file of new subjects, save and sync |
| | `skolem.ts`, `ids.ts`, `terms.ts`, `moved-ids.ts` | Blank-node replacement, identity, IDs that a change replaced |
| | `commands.ts`, `ops.ts`, `elements.ts`, `shape-ops.ts`, `figure-edits.ts` | Command dispatch and edit effects; removal, arrival and data arrival of figures (ADR 0014) |
| | `sparql.ts`, `queries.ts`, `records.ts`, `view-read.ts`, `scoped-doc.ts`, `selection.ts` | Shared SPARQL rules, read models of one view or one request |
| | `explorer.ts`, `outline.ts`, `properties.ts`, `search.ts`, `actions.ts`, `link-choices.ts` | Panel and action queries |
| | `shapes.ts`, `shapes-read.ts`, `shape-proposal.ts` | Metamodel, shapes index, shapes proposed from data |
| | `validate.ts`, `validation-runner.ts`, `validation-worker.ts`, `plain-quads.ts` | Debounced SHACL validation in a worker thread |
| | `notations.ts`, `../notations/*.ttl` | Built-in notation files (copied next to the backend bundle) and the input of the notation engine |
| `modeler/src/common` | `protocol.ts`, `cli-protocol.ts`, `views-html.ts`, `view-order.ts` | RPC, CLI and export contracts |
| `modeler/src/node` | `model-service.ts`, `cli-endpoint.ts`, `cli-token-validator.ts` | RPC service, CLI endpoint |
| | `glsp/` | GLSP server, one session per view, operation handlers, layout |
| `modeler/src/browser` | `actions.ts`, `action-service.ts`, `action-commands.ts`, `action-menus.ts`, `follow-up.ts` | Actions, prompts, creation follow-up |
| | `selection-model.ts`, `model-client.ts`, `commands.ts`, `menus.ts`, `outline.ts`, `problems.ts`, `side-panel-sizes.ts` | Window state and shell integration |
| | `diagram/`, `notes/` | Canvas rendering, gestures, clipboard, notes, export. `pending-*.ts`: moves and new members shown before the server confirms them |
| | `explorer/`, `search/`, `properties/`, `prefixes/` | Panels and Workspace settings |
| | `rdf-language*.ts`, `cli-bridge.ts`, `file-kinds-decorator.ts` | Text highlighting, CLI window adapter, file navigator labels |
| `scripts` | `esbuild-catenary.mjs`, `dev-workspace.sh`, `start-browser.sh`, `desktop.sh`, `verify.mjs`, `e2e.cjs`, `catenary.mjs`, `check-boundaries.mjs`, `check-manifests.mjs` | Build, example workspace setup, hosts, verification, browser tests, CLI, import rules, manifest typecheck |
| | `package-windows.sh`, `check-windows-package.mjs`, `smoke-desktop.mjs` | Windows package, its static check, desktop smoke test (`.github/workflows/windows.yml`) |

## Hosts

- **Browser app** (`app/`): Theia backend and frontend on `http://localhost:3100`. The e2e tests and the CLI checks use it.
- **Electron app** (`electron-app/`): the same Theia packages and extension in one desktop process. One process serves one profile and holds one `ModelStore`. `scripts/desktop.sh` gives each workspace its own profile in `~/.config/catenary/profiles/<hash>`, so each workspace runs in its own process. A request for a second window (New Window, a workspace opened in a new window, a second launch) starts a new process with the profile of its workspace. A request for the workspace of the running process focuses its window. Code: `modeler/src/electron-main/electron-main-module.ts`.
- Both start the Theia plugin host with the VS Code Git extensions (`--plugins=local-dir:plugins`) for Source Control. Run, Debug and Testing contributions are hidden.

## Persistence

- Each edit, undo and redo queues a write. The queue runs file operations one at a time.
- A Turtle file gets a text patch: only the blocks of the changed subjects change. Catenary parses the result again and compares it with the expected RDF before it accepts it.
- Other formats, TriG view files and failed patches get a whole-file write: first in the style of the file, then with the canonical writer as fallback.
- Writes go to temporary files, then rename. Cross-file rollback does not exist (open work STORE2).
- Catenary refuses to overwrite a file whose disk text differs from its last read or write.
- The watcher reads changed files 150 ms after the last event. A read from disk clears the undo history.

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
| `scripts/smoke-desktop.mjs` | The desktop app or the Windows package: paths, writes, Git, watcher, plugins, native modules |

Path rules take the platform as a parameter (`path.win32` or `path.posix`), so the tests check the Windows rules on Linux. The Windows workflow runs the same tests on Windows.

Test oracles: `packages/rdf/test/project-full.ts` (read model of the whole dataset) and `packages/model/test/doc-reference.ts`. The application uses neither. `scoped-doc.test.ts` compares the store answers with them.

Assert fields and geometry invariants, not whole-render snapshots or exact ELK coordinates. Query RDF results with the `rdf` CLI and SPARQL, including named graphs. Never run tests against `workspace/`.
