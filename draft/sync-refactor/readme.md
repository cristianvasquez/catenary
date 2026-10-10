# Sync refactor: files, store, validation and figures

This folder is the handoff for the refactor of file and store synchronization. Start here. Take the first remaining stage whose "Needs" are done. Do one stage per pull request.

The picture of today and of the target is in the [Catenary Sync Map](https://claude.ai/artifact/MrKyfiMWjnYDzYoEjKftGW). This readme is the text contract for agents. If the two differ, this readme wins.

## Why

Two classes hold most of the sync work today:

- `Workspace` (`packages/rdf/src/workspace.ts`, about 1,080 lines) has six jobs: load, reconcile, provenance, save plan, dirty check and the choice of validation data.
- `ModelStore` (`packages/rdf/src/model-store.ts`, about 1,330 lines) has six jobs: edit and undo, the write queue and Git, the watch loop, validation wiring, change notification, and about 50 panel queries.

The model graph `urn:name:model` merges the data of all files. A side map (`origin`, `byFile`, `lastOrigin`) remembers the file of each statement. Shapes and views use graph names for the same purpose.

## Decisions

These decisions were made on 10 Oct 2026 in the project thread. Do not reopen them in a stage.

1. **One named graph per file and role.** A model file gets a data graph, and also a shapes graph when it has shapes. A view file keeps its one view graph. The report graph stays. The graph name gives the file. The side map is removed.
2. **The data and shapes split at load stays** (`shapePart`). Queries keep telling data from shapes by graph.
3. **A triple that two files hold is stored twice**, once in each data graph. A read over all data removes duplicates. Oxigraph 0.5.11 can query a list of graphs as one graph (query option `default_graph` with a list). This was tested.
4. **No notation index.** The global JSON mirror of the store (`TripleIndex`, kept by `IndexedStore` in `packages/rdf/src/notations.ts`) is removed. Its only readers are the diagram figures.
5. **Each view owns its figure input.** When a change touches a view, its slice is read from the store with SPARQL, and its figures are derived once. Every canvas that shows the view gets those figures through its own GLSP connection.
6. **ModelStore becomes the coordinator.** It runs a command, gets one patch and sends one change event. It has no other job.

## Terms

| Term | Meaning |
|---|---|
| View | One diagram: one view file and its graph in the store. Shared by all users. |
| Canvas | One open tab that shows a view. Many canvases can show the same view. |
| GLSP connection | The link between one canvas and the backend. GLSP makes one for each open canvas. |
| Slice | What the figures of one view read. See stage 5. |
| Patch | The added and removed quads of one transaction. |
| Change event | One message after each patch: the graphs and the elements that the patch touched. |
| Coordinator | What stays of `ModelStore`. |

## Target modules

| Module | One job |
|---|---|
| Settings | The manifest, file membership and imported globs. |
| Loader | Read a file into its graphs: a data graph and a shapes graph, or a view graph. Writes through a patch. |
| Reconciler | After a watch event, reload the graphs of each file that another program changed. |
| Placement | Give each new data triple the graph of the file where it belongs. |
| Saver | For each graph that a patch touched, patch the file text or write the whole file. Then commit. |
| Validator | A pure function: data quads and shape quads in, a report out. |
| View figures | Read the slice of a view and run the notation engine on it. |
| Coordinator | Run a command, get one patch, send one change event. |

`packages/rdf-files` already has one job for each module. Do not change it in this refactor.

## Stages

Each stage is one pull request. Each stage must pass `pnpm verify` on its own. Add `--e2e` when a stage changes browser wiring. Each stage updates the manifest sections that it names. It also updates `docs/architecture.md` (code map) and `spec/open.md`.

### Stage 2: one graph per file and role

- **Needs:** the shared patch event path in `ModelGraph`.
- **Goal:** store each file in its own graphs (decisions 1 to 3). Remove `origin`, `byFile` and `lastOrigin`. Placement runs inside the transaction, so the patch has the final graphs. Undo then needs no origin changes (`OriginChange` in `history.ts`). Touched graphs invalidate the canonical content cache of their files. Dirty state compares current canonical file content with the last read or successful write, as §10.1 requires.
- **Files:** `graph.ts` (`model` becomes a scope over the data graphs, with duplicates removed on read), `workspace.ts`, `placement.ts`, `history.ts`, `sparql.ts`, and each query that names `urn:name:model` (`queries.ts`, `scoped-doc.ts`, `view-read.ts`, `properties.ts`, `link-choices.ts`, `outline.ts`, `search.ts`).
- **Open first:** resolve SYNC1 in [spec/open.md](../../spec/open.md#decisions) before this stage starts.
- **Done when:** a statement in two files is in two data graphs. Undo and redo keep it there (`law_originKept`, `law_undoKeepsOrigin`). A transfer between files is a graph change in the patch. Undo before a queued write clears dirty state when the file returns to its saved content. Reversing an edit after a failed write also clears dirty state when the saved content is restored. Neither case causes a needless write, retry or commit. `file-explorer.test.ts`, `placement.test.ts`, `workspace-files.test.ts`, `imported-files.test.ts`, `review-save.test.ts` and `scoped-doc.test.ts` pass with these dirty-state regressions covered.
- **Manifest:** §3.1 (graphs), §3.2 (statement origin), §10.1 (preserve canonical comparison, `law_saveCleans` and `law_failedWriteStaysDirty`; use touched graphs for cache invalidation).

### Stage 3: split Workspace

- **Needs:** stage 2.
- **Goal:** move the jobs of `Workspace` into Settings, Loader, Reconciler, Placement and Saver. Give each module a small file and a clear name. The coordinator, not `Workspace`, creates the store.
- **Files:** `workspace.ts` (removed or reduced to Settings), new module files, `model-store.ts`.
- **Done when:** each module has one job from the table above. No module imports another sync module except through the coordinator. `scripts/check-boundaries.mjs` enforces this if the modules become packages.
- **Manifest:** §2 (workspace and files), §10 (writes, Git and watcher).

### Stage 4: pure validator

- **Needs:** stage 2.
- **Goal:** the validator takes data quads and shape quads and returns a report. The coordinator writes the report graph and acts on the change event. The worker keeps getting a full copy for each run.
- **Validation data:** include the data graphs of own files and the context that `Workspace.validationTriples` adds today. Also include the SKOS projection of all shapes graphs, own and imported. This projection selects SKOS predicates and `rdf:type` statements whose object is in the SKOS namespace, as `ValidationRunner.validateNow` does today. All mode includes the whole projection. OpenViews mode includes only projection statements about focused elements and IRIs named by the selected data, as §9 requires. Off mode runs no validation.
- **Shapes:** include all shapes graphs, own and imported.
- **Files:** `validation-runner.ts`, `validate.ts`, `model-store.ts`, `workspace.ts` (`validationTriples`).
- **Open first:** resolve SYNC2 in [spec/open.md](../../spec/open.md#decisions) before this stage starts.
- **Done when:** the validator imports nothing from the store or the workspace. `validation-runner.test.ts` and `validation-mode.test.ts` pass. Tests cover scheme membership supplied only by shapes-file SKOS statements in both All and OpenViews modes. OpenViews tests also cover exclusion of unrelated shapes-file vocabulary. Cover own and imported shapes files.
- **Manifest:** §9 (validation).

### Stage 5: view slices, no notation index

- **Needs:** nothing. It can run in parallel with stages 2 to 4.
- **Goal:** prove that a slice gives the same figures as the whole store, then use slices and delete the mirror.
- **Slice of a view** (from `notation.ts`, `notation-join.ts`, `figure-edits.ts` and `packages/rdf/notations/*.ttl`):
  1. The view graph: its placements and its `nt:notations`.
  2. All shapes graphs. Shape rules follow paths of up to three steps inside the shapes, for example `( sh:node sh:property sh:hasValue )`.
  3. For each placed element: all its outgoing triples.
  4. Incoming triples only for the inverse paths that the notation files name: today `skos:inScheme`, `view:arrow`, `owl:disjointUnionOf` and `sh:property`. Derive this list from the notation files, not from a list in code.
  5. For each value that steps 3 and 4 reach: its labels (`rdfs:label`, `skos:prefLabel`, `sh:name`), its `rdf:type`, and its list cells when it is an RDF list.
  6. The superclass chain of each type.
- **Steps:**
  1. Add a test: for each view of `packages/rdf/test/fixtures/notation`, the figures and the join from the slice are equal to the figures and the join from the whole store. Run the removal, arrival and data-arrival rules on both.
  2. Read the slice with SPARQL in the backend, once per view and change. `ModelStore.viewFigures`, `figure-edits.ts`, `clipboard.ts` and `glsp/layout.ts` use it.
  3. Delete `IndexedStore` and `storeIndex`. `TripleIndex` stays only as the small per-view input of the engine.
- **Done when:** step 1 passes on every fixture view. No code builds a `TripleIndex` of the whole store. Measure a non-layout edit on the 20,000-instance workload of PERF2 in `spec/open.md`, before and after.
- **Manifest:** §4.1 (notations and placements), §3.3 (read models).

### Stage 6: coordinator

- **Needs:** stages 3 and 4. PR #34 is merged: it added the query port (`packages/query`) and one provider contract per reader (`packages/palette`, `packages/links`, `packages/fields`).
- **Goal:** `ModelStore` keeps only the coordinator job. Panel queries move behind those providers. Writes and commits move to the Saver. The watch loop moves to the Reconciler.
- **Done when:** `model-store.ts` has no SPARQL text and no file I/O. The RPC service still takes its queries from `MODEL_QUERIES` (`packages/model/src/queries.ts`).
- **Manifest:** §11 (read interface).

## Rules for each stage

- Read `AGENTS.md` first. Run `git status --short`, and do not revert changes of other agents.
- Keep each stage small. Do not start the next stage in the same pull request.
- When a stage changes a contract, change the manifest section and its law first. Then change the code.
- Put new open items in `spec/open.md`. Remove completed work from this handoff. Git history records completed stages.
- When all stages are done, delete this folder.
