# Sync refactor: files, store, validation and figures

This folder is the handoff for the refactor of file and store synchronization. Start here. Take the first remaining stage whose "Needs" are done. Do one stage per pull request.

The picture of today and of the target is in the [Catenary Sync Map](https://claude.ai/artifact/MrKyfiMWjnYDzYoEjKftGW). This readme is the text contract for agents. If the two differ, this readme wins.

## Why

`ModelStore` still holds most of the sync work:

- `ModelStore` (`packages/rdf/src/model-store.ts`, about 1,330 lines) has six jobs: edit and undo, the write queue and Git, the watch loop, validation wiring, change notification, and about 50 panel queries.

Each model file uses a data graph and a shapes graph. The jobs of the former `Workspace` are modules (`settings.ts`, `loader.ts`, `reconciler.ts`, `placement.ts`, `saver.ts`, `validation-data.ts`) that ModelStore wires.

## Decisions

These decisions were made on 10 Oct 2026 in the project thread. Do not reopen them in a stage.

1. **One named graph per file and role.** A model file gets a data graph, and also a shapes graph when it has shapes. A view file keeps its one view graph. The report graph stays. The graph name gives the file. The side map is removed.
2. **The data and shapes split at load stays** (`shapePart`). Queries keep telling data from shapes by graph.
3. **A triple that two files hold is stored twice**, once in each data graph. A read over all data removes duplicates. Oxigraph 0.5.11 can query several data graphs through one default scope. This scope must remove duplicate query bindings.
4. **No notation index.** The global JSON mirror of the store (`TripleIndex`, kept by `IndexedStore` in `packages/rdf/src/notations.ts`) is removed. Its only readers are the diagram figures.
5. **Each view owns its figure input.** When a change touches a view, its slice is read from the store (pattern lookups around its placed terms, no copy), and its figures are derived once. Every canvas that shows the view gets those figures through its own GLSP connection.
6. **ModelStore becomes the coordinator.** It runs a command, gets one patch and sends one change event. It has no other job.

## Terms

| Term | Meaning |
|---|---|
| View | One diagram: one view file and its graph in the store. Shared by all users. |
| Canvas | One open tab that shows a view. Many canvases can show the same view. |
| GLSP connection | The link between one canvas and the backend. GLSP makes one for each open canvas. |
| Slice | What the figures of one view read: the store around its placed terms (`viewFiguresOf` in `packages/rdf/src/notations.ts`). |
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

### Stage 4: pure validator

- **Needs:** per-file data and shapes graphs in `ModelGraph`.
- **Goal:** the validator takes data quads and shape quads and returns a report. The coordinator writes the report graph and acts on the change event. The worker keeps getting a full copy for each run.
- **Validation data:** include the data graphs of own files and the context that `validationTriples` (`validation-data.ts`) adds today. Also include the SKOS projection of all shapes graphs, own and imported. This projection selects SKOS predicates and `rdf:type` statements whose object is in the SKOS namespace, as `ValidationRunner.validateNow` does today. All mode includes the whole projection. OpenViews mode includes only projection statements about focused elements and IRIs named by the selected data, as §9 requires. Off mode runs no validation.
- **Shapes:** include all shapes graphs, own and imported.
- **Files:** `validation-runner.ts`, `validate.ts`, `model-store.ts`, `validation-data.ts` (`validationTriples`).
- **Open first:** resolve SYNC2 in [spec/open.md](../../spec/open.md#decisions) before this stage starts.
- **Done when:** the validator imports nothing from the store or the workspace. `validation-runner.test.ts` and `validation-mode.test.ts` pass. Tests cover scheme membership supplied only by shapes-file SKOS statements in both All and OpenViews modes. OpenViews tests also cover exclusion of unrelated shapes-file vocabulary. Cover own and imported shapes files.
- **Manifest:** §9 (validation).

### Stage 6: coordinator

- **Needs:** stage 4. PR #34 is merged: it added the query port (`packages/query`) and one provider contract per reader (`packages/palette`, `packages/links`, `packages/fields`).
- **Goal:** `ModelStore` keeps only the coordinator job. Panel queries move behind those providers. Writes and commits move to the Saver. The watch loop moves to the Reconciler.
- **Done when:** `model-store.ts` has no SPARQL text and no file I/O. The RPC service still takes its queries from `MODEL_QUERIES` (`packages/model/src/queries.ts`).
- **Manifest:** §11 (read interface).

## Rules for each stage

- Read `AGENTS.md` first. Run `git status --short`, and do not revert changes of other agents.
- Keep each stage small. Do not start the next stage in the same pull request.
- When a stage changes a contract, change the manifest section and its law first. Then change the code.
- Put new open items in `spec/open.md`. Remove completed work from this handoff. Git history records completed stages.
- When all stages are done, delete this folder.
