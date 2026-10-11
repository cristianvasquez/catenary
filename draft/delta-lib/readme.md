# Delta library: vision and status

A handoff for the extraction of a generic library from Catenary. The library watches RDF files, keeps them in a quad store with a SPARQL interface, and accepts changes as patches that it writes back to the files as text patches. Plugins subscribe to partitions of the store, for example a SHACL validator. This document holds the vision, the decisions that are made, the decisions that are open, and the katas that move the code toward the cut. It is a draft: the manifests are the contract.

## Vision

One process owns a folder of files. Each file is one named graph of the store. A client reads with SPARQL. A client writes a patch: an ordered list of add and remove of quads, each with its concrete graph. The library applies the patch in one transaction, publishes one event, writes each changed file as a text patch that keeps the rest of the text byte for byte, and makes a git commit. Another program can change a file on disk: the watcher reads it again and publishes the event. A plugin subscribes to a partition (a set of graphs selected by a predicate) and gets a snapshot and then each event restricted to it. A validator is such a plugin: it reads the data and shapes partitions and writes its report into a report graph through the same patch path.

Catenary is the first host. It supplies the policies that the library does not own: which file gets a new statement (placement), what the union of the data graphs is, which graphs are read only, and the vocabulary readers (SHACL, RDFS) of its user interface.

A later host triplifies other artifacts. A syntax port maps a file to quads with positions and a patch to text edits. Turtle and TriG are the first syntax (tree-sitter). Another syntax, for example a Markdown dialect, is a second implementation of the same port and can refuse a patch, and the library then writes the whole file.

## Terms

The terms are locked in spec/manifest.hs, section "Glossary" (kata 9pft). In short: graph, role, partition, patch, transaction, event, readOnly, import, union, placement.

## What exists today

| Piece | Where | State |
|---|---|---|
| Watch, own-write filter, atomic multi-file write, git commit | packages/rdf-files/src/file-sync.ts, git.ts | Generic, tested. Extractable now. |
| Quad store port and Oxigraph store, SPARQL SELECT and CONSTRUCT | packages/rdf-files/src/store.ts, oxigraph-store.ts | Generic. No SPARQL UPDATE. |
| Text patch of Turtle and of a TriG graph block, tree-sitter, incremental | packages/rdf-files/src/text-patch.ts | Generic. Turtle only. No syntax port yet. |
| Transaction, patch log, undo, redo, event | packages/rdf/src/graph.ts (ModelGraph), history.ts | graph.ts holds only the core after 0yan; the boundary checker limits its imports to change.ts, skolem.ts, terms.ts. Catenary rules (isView, metamodelQuad) come in through the constructor. Katas mpwz, dywb continue. |
| Graph roles (data, shapes, view, report) | packages/rdf/src/graph.ts registry | Generic idea, Catenary roles. |
| readOnly gate | packages/rdf/src/settings.ts readOnlyReason (after kata 1kmq) | One predicate, three reasons. The manifest and the import workflow set it. |
| Placement of new statements | packages/rdf/src/placement.ts | Catenary policy. Not for the library. |
| Reconciler (read again after a watch event) | packages/rdf/src/reconciler.ts | Generic logic on Catenary settings. |
| Saver (patch to file texts, all or none) | packages/rdf/src/saver.ts | Generic logic on Catenary settings and graph roles. |
| Validation runner (debounce, stale runs, worker) | packages/rdf/src/validation-runner.ts | The first plugin, hand wired in model-store.ts. |
| SPARQL endpoint for clients | none | The RPC exposes declared queries only (packages/model/src/queries.ts). |

## Decisions made

1. The library does not guess the graph of a new statement. The host gives a placement function. The library supplies the facts the function needs: the graphs where the subject already has statements, and the graphs a removed copy of the same triple came from. The function returns graphs or refuses. Catenary keeps its "near" heuristic as its host function. Whether a host asks the user is a host choice.
2. Graph per file is the primary write contract. The union graph and its placement step are a layer of the host. Kata mpwz makes every write name its graph so that this change becomes a search for one token.
3. A patch has concrete graphs only. A remove of a triple in the union removes every copy in every data graph (manifest rule). An event is the committed patch, its sequence number and the graphs it touched. Cache keys of the host are not part of the event.
4. readOnly is one predicate with a reason. Import is a workflow that sets it.
5. Extraction happens in this repository first, as workspace packages with the boundary checker enforcing "no @catenary import". A move to another repository waits for a second consumer.
6. Package granularity: merge the five one-file contract packages into one (kata 9r4p); split @catenary/rdf into rdf-core and the rest (kata dywb).

## Decisions open

1. Partitions and subscriptions. Write down three concrete subscribers before designing the interface: the SHACL validator (data and shapes), an endpoint client (one graph), and the Catenary caches (the five booleans of GraphChange today). Then define snapshot and subscribe over a graph predicate and check that each subscriber fits.
2. The syntax port. Its shape is read (text to quads with positions), position (quad to a point in the text), patch (a statement diff to text edits, or a refusal), and an optional whole-file write. Do not design past that until a second syntax exists.
3. SPARQL UPDATE or a quad-diff API as the write entry of the endpoint. The transaction gives a patch either way; the question is only the wire format.
4. The readOnly gate inside the core or in the host. It is a predicate over a graph; the core can own it if the host supplies the predicate.
5. The name of the library and whether rdf-files and rdf-core merge into one package or stay two (files and store, versus transaction and events).

## Katas

In order of dependency. Each is an issue in kata (project catenary, label kata).

| Kata | Title | Depends on |
|---|---|---|
| 9pft | Terms: lock one name per concept in the manifest | none |
| j6xk | rdf-files: readme, version and package fields | none |
| 1kmq | readOnly: one predicate for the write refusal | 9pft (the term) |
| 9r4p | Merge the five contract packages into @catenary/contracts | none |
| 0yan | graph.ts: move vocabulary and view helpers out of ModelGraph | 1kmq, 9r4p |
| mpwz | ModelGraph.add and set: the graph is a required parameter | 0yan |
| dywb | Split @catenary/rdf: rdf-core and the Catenary rest | mpwz |

After dywb, the report of what was hard to cut is the input of the open decisions above. That report, 2026-10-12:

**Still in @catenary/rdf, candidates for the core:** the span mechanism of trace.ts (AsyncLocalStorage, TracedStore) once split from the Catenary record types; the TriG writer in trig.ts if MANIFEST_GRAPH and PREFIXES become parameters; the generic part of change.ts (quadKind, quadDependencies, layoutOnly), which depends only on the view layout predicates and could be a parameterized module; ids.ts (elementId) if it is generic; the readOnly gate of settings.ts, not examined.

**In the core but Catenary in content:** resolved by kata f5zb (GraphNames through the constructor). The History field is still named migrations.

**Cuts made:** change.ts stays in @catenary/rdf; ModelGraph gets `dependencies` and `layoutOnly` through its rules parameter. The migration types became a type parameter: core ModelGraph<P> with proposed: P[], History<C>; @catenary/rdf/graph.ts aliases ModelGraph = CoreModelGraph<Proposal> so that 69 importers did not change. TermJSON is duplicated in rdf-core because @catenary/model runs in the browser. rdf-core has its own copy of the rdf-ext typings (packages cannot share an ambient module declaration); keep the two copies equal.

## How an agent works a kata

Local only: no push, no pull request. The full contract is the `develop-with-kata` skill.

1. `git worktree add <dir> -b kata/<id>-<slug> main`, then in it `pnpm install --prefer-offline --frozen-lockfile`.
2. Read AGENTS.md, then the kata (`kata show <id>`).
3. Make the change. `pnpm verify`. Commit with the kata id in the message. The post-commit hook starts a roborev review.
4. Apply the review findings that stay inside the kata and this document. A finding that asks for a change outside them: comment on the kata, label needs-review, stop.
5. Close the kata with the commit. The orchestrator merges the branch into local main.

## Progress

| Kata | State | Commit |
|---|---|---|
| 9pft, 1kmq, 9r4p, j6xk | closed, merged into main 2026-10-12 | bd56945, ab3ba98, f1f14a0, 4144b61 |
| 0yan | closed, merged into main | e850e55. graph.ts 680 to 393 lines; rules are a constructor parameter, `newModelGraph` in model-graph.ts |
| mpwz | closed, merged into main | 590bcd4. `add` and `set` take a required graph; 24 sites changed (the kata body said 124: a grep that counted `Set.add` too) |
| f5zb | closed, merged into main | c28e3ec. Graph names honour their intent (UNION_GRAPH, REPORT_GRAPH, SHAPES_GRAPH_PREFIX); rdf-core owns no IRI value: GraphNames and the skolem base come from the host through the constructor; boundary rule: no `urn:` literal in rdf-core |
| dywb | closed, merged into main | 8f24d5e. packages/rdf-core: graph.ts, history.ts, skolem.ts, terms.ts, plain-quads.ts; no @catenary import, enforced by the boundary checker |

Note: the first round also pushed its branches and opened pull requests #43 to #46 on GitHub by mistake. They are not merged there. Local main has the same commits.
