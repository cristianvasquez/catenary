-- | Catenary data contract: files, RDF, commands, transactions, persistence, read interface and CLI.
-- Interaction rules: spec/ui-manifest.hs. Unresolved decisions and known gaps: spec/open.md.
-- Haskell notation only. This file does not compile, and pnpm verify does not check it.
-- Signatures describe effects, not a wire schema. TypeScript defines exact fields (paths named in each section).
-- IO is an external effect. Tx is a synchronous store transaction. Either Error is a rejection.
-- Sections go from the outside in: terms, workspace, store, views, commands, shapes, validation, persistence, reads, CLI.

module Catenary.Manifest where

-- | Design rules. Code comments cite them as "ADR <n>". Each line gives the rule, its reason, and where the contract states it.
-- ADR 0001  One operation per action for all element kinds (rename, setUri, delete, copy, setStatements, one view-box model);
--           kind-specific code only where the meaning differs (paths, ranges, sh:or lists, migrations). One read-model record
--           per kind, shared accessors. Reason: a fix applies to all kinds. §5.
-- ADR 0003  The files are the model; the store is an index. An edit writes a text patch at once and makes a Git commit. §2, §8.
-- ADR 0004  Files have no roles: what a file contains comes from its triples. §2.
-- ADR 0005  Electron app next to the browser app. One process, one profile, one ModelStore per workspace; a second window
--           starts a new process (scripts/desktop.sh, electron-main-module.ts). Headless Electron gives no working window.
-- ADR 0006  Each Model explorer folder is one SPARQL query, run when it opens. spec/ui-manifest.hs §7.
-- ADR 0007  The frontend holds UI state only; panels read from backend queries. §9.
-- ADR 0011  View files are TriG; placement IRIs derive from what they place. §4.
-- ADR 0012  No read model of the whole dataset; request-scoped read models from shared SPARQL rules. §3, §9.
-- ADR 0013  Client feedback until the server confirms (3 s moves, 5 s pending rows); scoped refresh; SHACL in a worker.
--           spec/ui-manifest.hs §5.
-- ADR 0014  Notations draw views: figures are derived, views store only placements. §4, §5, spec/ui-manifest.hs §2, §6.
--           Vocabulary and SHACL of the Catenary model: docs/notation/. Built-in notations: packages/rdf/notations/.

-- 1. Terms and identity ------------------------------------------------------

type Iri = String
type Id = String
type Error = String
data Term = NamedNode Iri | Literal String Iri (Maybe String) (Maybe Direction) | TripleTerm Term Iri Term
data Direction = Ltr | Rtl
data Quad = Quad Term Iri Term Iri   -- subject, predicate, object, graph
data Side = Top | Right | Bottom | Left

-- | No blank nodes. A read replaces each blank node by urn:skolem:<uuid> (skolem.ts).
-- After the read every node is an IRI. Do not add code that keeps, handles or writes back blank nodes.
-- A file with blank nodes gets the IRIs at its next write. A file that Catenary does not write stays as it is.
-- SHACL paths are decided by structure (path operators, lists), not by term type (patches/shacl-engine@1.1.2.patch).
skolemize :: [Quad] -> [Quad]

-- | Owned nested resource: a skolem IRI, or a shape part <owner>-…, with no other referrer. It joins copy and deletion of its owner.
ownedBy :: Iri -> [Iri]

-- | Element IDs encode terms, not labels. An IRI ID is n-<escaped IRI>. A relation ID encodes its triple.
-- An IRI change changes the ID. The snapshot field movedIds lets selection and editors follow the change.
-- Property-shape IRIs stay stable through path and range edits. Renaming an owner does not rename nested resource IRIs.
-- Exact encodings: packages/model/src/ids.ts, packages/rdf/src/ids.ts.
elementId :: Iri -> Id
relationId :: Term -> Iri -> Term -> Id

-- 2. Workspace and files -----------------------------------------------------

-- | A workspace is a folder of RDF files. The files are the source of truth (ADR 0003). Files have no roles (ADR 0004).
-- The optional TriG workspace file holds one graph, urn:name:workspace, in namespace osg://vocab/workspace#.
-- A workspace file with other graphs does not open.
data WorkspaceSettings = WorkspaceSettings
  { defaultFile :: Maybe FilePath                          -- ws:defaultFile
  , placeShapes, placeConcepts, placeInstances :: Place   -- ws:placeShapes, ws:placeConcepts, ws:placeInstances
  , exclude :: [String]                                    -- ws:exclude globs
  , exportViews :: [Iri]                                   -- ws:exportViews, an RDF list
  , prefixes :: [(String, Iri)]                            -- sh:declare / sh:prefix / sh:namespace
  }
-- Relative paths resolve against the folder of the workspace file. Writers use / separators on all platforms.

-- | Open a folder: use workspace.trig, else its only workspace file. Several candidates require an explicit choice.
-- No workspace file: use default settings. The window asks the placement once. Create writes workspace.trig.
-- Otherwise the first settings change writes the workspace file.
-- Reject a view file (*.view.trig): it is part of a workspace. The window opens it in its view editor.
-- Create: ask the placement, then write the workspace file, an empty file for each file of the placement,
-- and views/main.view.trig with the view Main. Proposed placement: <name>.shapes.ttl, <name>.skos.ttl, all other subjects near.
-- Existing file content stays.
open :: FilePath -> IO CommandResult
create :: FilePath -> Maybe WorkspaceSettings -> IO CommandResult

-- | Membership: supported RDF files of the folder and its subfolders. Not: hidden entries, *.bak, node_modules,
-- other workspace files, ws:exclude matches. A subfolder with its own workspace file is a nested workspace, outside this one.
-- A .json file needs @context. Automatic discovery excludes .xml.
-- Read and write: Turtle, TriG, N-Triples, N-Quads, JSON-LD. Read only: N3, RDF/XML.
-- Exact extensions and media types: packages/rdf-files/src/formats.ts, RDF_FORMATS.
-- Relative IRIs resolve against the URI of each source file. An unreadable file gives a warning, not invented content.
modelFiles :: FilePath -> IO [FilePath]

-- | A view file is a *.view.trig file in any folder (ADR 0011). It has one named graph G and no statements outside G.
-- G is the view IRI and the only view:View of the file. Reject other view files, a view:View in another file and duplicate view IRIs.
-- There is no read of the old *.view.ttl format.
-- A new view uses a free views/<label>.view.trig path, or the createView folder inside the workspace.
-- A rename or IRI change keeps the file path. Deleting a view removes its file at the next write.
isViewFile :: FilePath -> Bool

-- | Placement of new subjects, by kind: shapes, SKOS resources, all other subjects (instances).
-- The workspace file stores "near" or a relative path for each kind. Writers store every kind explicitly.
-- A kind without a value: with ws:defaultFile, shapes use that file and the other kinds are near. Without it, all are near.
-- The legacy value "default" means ws:defaultFile, or near without one.
-- Near shapes: the writable file with most node shapes. Near concepts: the file of their scheme or collection.
-- Near instances: the file with most subjects of their classes. Otherwise: the default file.
-- Default file: ws:defaultFile when set. Else a nonempty writable model file that is not the shapes or SKOS file,
-- Turtle first, then path order. Else <workspace name>.ttl. The settings view shows it but does not edit ws:defaultFile.
data Place = File FilePath | Near
fileForNew :: WorkspaceSettings -> Iri -> FilePath

-- | Prefixes: one table per backend, from the workspace file. Prefix declarations in model files do not fill it.
-- No declarations: use defaults without a rewrite of the workspace file. Reject two prefixes for one namespace.
-- Settings, prefixes, export order and migration dismissal are not undo steps. A change of exclusions reloads membership.
-- Person preferences are not part of this contract.
setSettings :: WorkspaceSettings -> IO CommandResult

-- 3. Store -------------------------------------------------------------------

-- | One backend ModelStore indexes one workspace in an in-memory Oxigraph store. All windows share it and its history.
-- No lock or merge protocol protects simultaneous clients.
-- The store is local and synchronous: an edit reads its own writes before its transaction ends.
-- Graphs, from Workspace.mount (workspace.ts):
--   <view IRI>              the statements of one view file
--   urn:file:<encoded path>  shape subjects and their nested nodes, per source file
--   urn:name:model          all other statements; the origin map records every source file of each statement
--   urn:trellis:validation   the SHACL report (section 7)
-- Preserve legacy Trellis IRIs because saved view placements use urn:trellis:list:*, and existing files use osg://vocab/trellis-* terms.
-- The workspace file stays in workspace metadata, outside the read models.
-- Source named-graph names of model files are not kept: a write loses them (open.md STORE1). Do not claim TriG round trips.
origin :: Quad -> [FilePath]

-- | Statement origin: existing triples keep their files. An addition prefers its prior origin, then the file of its subject,
-- then the file of a referring statement. A preferred read-only file gives the default file.
-- A deletion from a read-only file cannot persist. IRI replacement and undo keep statement origins.
fileForAdd :: Quad -> FilePath

-- 4. Views in RDF ------------------------------------------------------------

-- | A view places elements and statements. Its notations give their figures (ADR 0014, spec/ui-manifest.hs §2).
--   v nt:notations ( n1 n2 … )                           the cascade of the view; absent: the default cascade (nt:default)
-- Notations are built into Catenary (packages/rdf/notations/). A workspace file does not define a notation.
-- A view names notations by IRI. Vocabulary and SHACL of the notation model: docs/notation/.
-- A placement holds geometry, color and display. A mark holds its own content. A view reference places the target view.
--   p view:element e ; view:view v                       an element: a box, a line (a property shape) or a hub (an RDF list)
--   p rdf:reifies <<( s p o )>> ; view:view v            a link (a triple); it does not assert the triple in the view graph
-- A Box placement has view:x, view:y, view:width, view:height and optional view:color and view:display "simple".
-- view:keptByLines true: a line or hub brought the box (⇥); the box leaves with its last line. Absent: the user placed it.
-- A datatype, node-kind or "any" pill has no placement: it is private to its line (ADR 0014).
-- A Line placement has no geometry: a read ignores it. view:fromSide and view:toSide are routing hints.
-- A Hub placement has an optional position. Without it, the layout computes one.
-- A hub, a "one of" box and an "in" box are placed by urn:trellis:list:<12 hex of SHA-256 of "<holder> <predicate> <n>">.
-- n: the position of the list among the lists of that holder and predicate, sorted by member text.
-- These are the inputs of the constraint id c-<operator>-<shape>-<n> (constraintId in packages/rdf/src/ids.ts).
-- A placement never names a list cell: commands rewrite list cells.
-- A view places an element or a triple at most once. Placement IRI: <view>/p/<12 hex of SHA-256 of the placed term>.
-- Catenary code checks the rules that SHACL Core cannot: one placement per term, no geometry on a line placement,
-- and a placement without a figure (a project warning in Problems, open.md NOTATION2).
-- Figures are derived in memory for each view read, like urn:trellis:validation. They are never written.
-- Mark IRI: <view>/m/<6 random base-36 characters>.
-- An IRI change of a view, an element or a triple end renames the placements and marks that derive from it.
placementIri :: Iri -> Term -> Iri
markIri :: Iri -> IO Iri

-- | Links: relations and arrows. Arrival and data arrival place links (§5).
-- Removing a link placement keeps the Domain triple. An arrival places it again only when the link touches an arriving figure.
-- A link to an entity-group member ends at the group (nt:linkEnd). The group draws the relations of its members as bundles,
-- without statement placements: a member relation is never hidden.
-- Arrows: view:arrow statements in Project data. At least one end is a note. Duplicate arrows are invalid.
-- An arrow placement goes when the view no longer shows an end, as a box or as a member of a shown entity group (pruneArrows).

-- | Read models (ADR 0012). There is no Doc of the whole dataset. Panels and editors build request-local display models.
-- A request-scoped Doc holds the elements of one request, their neighbors when asked, and the views that can show them.
-- The other views of a scoped Doc have their label only. A scoped Doc is not kept after its request.
-- Unmapped RDF statements stay in the store and the files.
-- ViewCard.id is the placement. ViewCard.element is its element. EdgeLayout.id is a connector placement when present.
-- Marks, references and arrows use placement IDs. Arrow ends are box IDs, not element IDs.
-- Exceptions with element IDs: unplaced links, property lines, private pills, list boxes and logical constraints.
-- Diagram IDs of SHACL and value-set figures: packages/model/src/notation-schema.ts.
-- The cascade order decides the figure of an element. The default cascade puts SHACL before instances,
-- so a node-shape card wins display over an instance with the same IRI. Action facts use all types.
-- Exact schemas: packages/model/src/doc.ts, snapshot.ts, terms.ts, shapes-doc.ts.
data Doc

-- | One view read takes its view graph and the relevant model statements by SPARQL (view-read.ts), not a cloned store.
-- A GLSP session refreshes only when the change scope touches its view.
-- A class target resolves to the first visible matching node shape by ID. Rendering and layout share this rule.
-- Parallel-edge lanes count unordered end pairs and allocate in drawing order.
-- A new field goes through RDF operations, read model, JSON schema and client model together. GLSP field copy has no type check.
viewDoc :: Iri -> IO Doc

-- 5. Commands and transactions -----------------------------------------------

data Change = Add Quad | Remove Quad
type Patch = [Change]
data Tx a
data EditCommand
data CommandResult = Success (Maybe Id) [Id] | Failure Error
transact :: Tx (Either Error a) -> IO (Either Error a, Patch)
execute :: EditCommand -> IO CommandResult
undo, redo :: IO ()
-- | One successful nonempty EditCommand gives one patch and one undo step. A no-op gives no history entry.
-- A rejection or an exception rolls back the store transaction. The store transaction is separate from the async file write.
-- A new edit clears redo. History keeps at most 200 steps. Undo and redo restore the migration queue of their step.
-- A command that names a view rejects a missing view. View commands accept element or placement IDs.
-- Variants and fields: packages/model/src/commands.ts. Dispatch and effects: packages/rdf/src/commands.ts.

-- | Resource edits: createInstance, rename, setUri, setStatements, delete, createRelation, reconnectRelation.
-- Labels are not identity. Reject empty labels and surrounding spaces. A copy label uses the next free numeric suffix.
-- New IRIs come from canonical-md and are free. An explicit IRI keeps its spelling. An empty Set IRI input mints from the label.
-- rename updates the applicable label predicate (rdfs:label, skos:prefLabel, sh:name).
-- setStatements replaces values only for the predicates it supplies.
-- A relation must satisfy the shapes, must not duplicate a triple and must not link an instance to itself.
-- reconnectRelation keeps the predicate, changes the relation ID and keeps layouts only where both new ends show.
-- A reconnect to the same end changes only its side.
-- setUri follows references across graphs, including triple terms. A shape IRI change excludes data rdf:type uses
-- and can propose a class migration.
-- delete by kind is provisional (open.md D1).

-- | View edits: createView, duplicateView, addToView, showRelations, showAsEdge, removeFromView, cutFromView.
-- Geometry edits: setBounds, setLayout, setEdgeLayout, hideEdges, setViewElements.
-- Mark edits: createGroup, createNote, addViewReference, addFileReference, createArrow.
-- Entity groups: collect, addToCollection, uncollect. Clipboard: pasteIntoView.
-- collect and addToCollection remove the own placement of each member and the placements of its relations.
-- An arrow placement stays: it ends at the group. uncollect gives each released member a placement beside the group.
-- Moving a frame at the same size moves its contained boxes. setLayout clears requested edge sides.
-- duplicateView makes new Project IRIs and rewrites internal references. Domain elements stay shared.
-- A file reference stores its path relative to the view file. setViewElements ignores fields that the target kind lacks.
-- A note edit carries expectedText. A stale edit is rejected.
-- addViewReference refuses a second reference to the same view. Paste skips it.

-- | Copy makes new instances with their types, fields, owned values and the relations between copied instances.
-- It keeps box geometry, color, display and copied relation layouts. Paste moves the clip to the requested top-left point.
-- Cut removes the source placements at once. Paste after cut reuses the same IRIs and skips cards the target view has.
-- Copy reads source content at paste time. Deleted source instances do not return. A clip from another model matches same IRIs only.
-- Frames include their contained boxes. Entity groups copy as member cards. Groups and notes copy their content.
-- Limit: clips omit arrows and file references.

-- | Arrival and removal (ADR 0014, spec/ui-manifest.hs §2) run in the command that places or removes, in the same patch.
-- Arrival: a command that places an element (addToView, drag, pasteIntoView, expand) also places, until nothing changes,
-- each hub whose ends are then shown, each line with a shown start and end, and each link between two shown figures.
-- Only what touches a figure that this arrival placed. A statement that a shown hub covers (nt:covers) is not placed.
-- Removal: removeFromView also removes the placements that need a removed figure, and each box kept by lines whose
-- last line it took. The removed elements return as rows. No data changes.
-- A placement whose element gets a new IRI is not an arrival.
-- showAsEdge, createPropertyShape and setPropertyShape run with arrivals off.
-- Data arrival: a command that adds a statement or a property shape places it in each view that shows its start and its
-- end. A line with a private or open end and a hub member do not arrive alone. A new constraint over lines that a view
-- places gets its hub there; the members lose their own placements. A list placement of an ungrouped constraint goes.
-- A command that changes the lists of a holder moves each list placement to the term of its new position n.
-- Code: executeCommand (packages/rdf/src/commands.ts) runs placeConnectors (links), syncFigures (figure-edits.ts: lines,
-- hubs, boxes) and pruneArrows after each command.

-- 6. Shapes, SKOS and migrations ---------------------------------------------

-- | Shape edits: createNodeShape, proposeShapes, setNodeShape, createPropertyShape, setPropertyShape,
-- groupProperties, setConstraint, ungroup, takeOutOfConstraint. They share the data transaction and undo history.
-- A new property owner or target can join the same creation command.
-- Writes support simple predicate paths only. Loaded complex paths stay readable. Unmapped constraints stay intact.
-- Ranges: class, node shape, datatype, node kind, value list, SKOS set, alternatives.
-- A property-level sh:or is alternatives only when each member has one range statement.
-- groupProperties removes the sh:property links and adds the logical list. A member without sh:minCount gets 1.
-- ungroup restores the sh:property links. sh:not takes one member. New list cells get store IRIs.
-- A node-shape target uses its target class when present, else sh:node. Scheme and collection targets keep helper shapes.
-- Limit: a property shape cannot move to another owner.

-- | proposeShapes (shape-proposal.ts, SHACLxtract) makes node shapes from the model graph and writes them to the shapes file.
-- Without classes: each IRI type of the model graph that no sh:targetClass names. Classes with a shape are skipped.
-- RDF, RDFS, OWL, SHACL, SKOS, view and workspace types get no proposal. rdf:type gets no property shape.
-- Each shape gets sh:name, the class label. The proposal describes the data. It is a draft, not a rule.
-- Limit: values in shapes files are not read (open.md G11).
proposeShapes :: [Iri] -> Tx (Either Error [Iri])

-- | SKOS edits: createValueSet, addConcept, removeConcept, setConceptBroader. Schemes, collections and concepts are Domain data.
-- Scheme membership uses skos:inScheme. Collection membership uses skos:member.
-- Removing a collection member keeps the concept. Removing a scheme concept deletes it only when no other scheme uses it.
-- Broader edits keep existing parents. Reject missing concepts, self-links and cycles, also through inverse skos:narrower.
-- Collection edits refresh helper sh:in lists. Plain legacy value lists are read only.

-- | Migrations: a path or target-class change can propose a migration of data that uses the old term.
-- An exclusive old term and an unused new term allow a wider rename through shapes, vocabulary and views.
-- Data predicate and type changes wait for Apply to data (migrateData, one command). Dismissal changes only the queue.
-- The queue is not saved. Datatype and cardinality changes give validation results, not migrations.
-- Opposing entries are unresolved (open.md MIGRATION1).
migrateData :: Id -> Tx (Either Error ())
dismissMigration :: Id -> IO ()

-- | Metamodel: built from all shape graphs and SKOS vocabulary. Several node shapes can target one class.
-- Class labels come from the class resource, not the node-shape name. Value-set relations accept permitted concepts only.
-- Forms use a temporary sh:in expansion of SKOS helper targets. Saved shapes and validation keep the original constraints.
-- Limit: forms edit direct-path properties only. Inverse paths and undeclared predicates have no generic form editing.
-- An external change or a rejected edit can rebuild the form and lose field focus.

-- 7. Validation --------------------------------------------------------------

-- | Validate model triples and the relevant shapes vocabulary 250 ms after a data or shape change.
-- Layout-only changes do not validate. SKOS changes rebuild the metamodel. A run made stale by a newer edit is discarded.
-- The bundled backend runs shacl-engine in a worker thread. Without the worker file, validation runs in the backend thread.
-- The report goes to urn:trellis:validation: derived, not saved, not in undo, not in the dirty comparison.
-- A result keeps focus, source shape, path, severity, component and message. A complex path can have no simple path field.
-- Explorer type folders and ordinary reads exclude the report graph.
validate :: IO ()

-- 8. Persistence -------------------------------------------------------------

save :: IO CommandResult
-- | File operations run one at a time. Each edit, undo and redo queues a write of the pending changes.
-- Dirty: a write is pending or failed. It compares current canonical content with saved content.
-- The canonical content of a file is computed again only when a change touched it, or after a read.
-- Save retries pending writes and commits. A successful command does not certify a disk write.
-- A failed write keeps the dirty state and reports its cause.

-- | Write form: a Turtle text patch where possible. It reads only the blocks of the changed subjects and keeps the
-- syntax tree of the last patched text of each file. Each candidate is parsed again and compared with the expected RDF.
-- Else the whole file: first in the style of the file, then the canonical writer as fallback. A fallback is reported.
-- No text patch for TriG (view files are written whole) and for a text with blank nodes.
-- Limit: the fallback can change comments, prefixes and statement order.
-- Refuse an overwrite when the disk text differs from the last read or write. A watcher reload can drop pending edits, with a warning.
-- Prepare temporary files, then rename. No cross-file rollback (open.md STORE2).

-- | Git: each write batch is one commit of its changed files, git commit --only. Unrelated staged changes stay out.
-- Files with outside uncommitted changes, found at open or reload, are not committed automatically. Ignored files stay out.
-- No repository: write files and warn once. A failed commit path is retried at a later write.
-- A batch can hold several command kinds. There is no promise of one commit per EditCommand.

-- | Watcher: recursive, 150 ms after the last event. It ignores hidden paths, temporary files and unchanged own writes.
-- Added, changed and removed model files update the store. A workspace-file change opens the workspace again.
-- A read from disk clears the whole undo history. A missing workspace file or folder stops reads and writes until the next open.
-- Theia text auto-save is off by default. A clean text editor reloads after a canvas write.

-- | RDF 1.2 limits: JSON-LD cannot write triple terms. Turtle and TriG files with annotations are read only while n3
-- parsing can lose statements (open.md RDF1). Triple-term canonicalization extends RDFC-1.0. It is not a standard.
-- Legacy view vocabulary has no upgrade path.

-- 9. Read interface ----------------------------------------------------------

-- | RPC carries JSON only. Interface: modeler/src/common/protocol.ts, ModelService.
-- Writes: open, create, execute, undo, redo, save, setSettings, setPrefixes, setExportViews, dismissMigration.
-- Reads: getSnapshot and the queries of packages/model/src/queries.ts (ModelQueries, MODEL_QUERIES):
--   panels     explorerChildren, explorerPaths, explorerElements, properties, outline, problems, search, links
--   views      viewLabels, view, viewGesture, appearance, occurrence, showing, unplaced
--   forms      formData, shapesText, shapes
--   selection  selected, selectionActions (also the cards of Show Details), sources
--   prompts    deletePlan, relationChoices, neighborChoices, shapeSourceChoices, linkChoices, newLabel,
--              knownPredicates, knownClasses, memberOptions, instancesNamed, elementRows
-- The pure rules on scoped Docs: packages/model/src/prompts.ts.
-- sources gives every source file of an element with an optional 1-based disk line. It does not parse all RDF spellings.
-- Backend queries supply panel data. The frontend owns selection, expansion, viewport and transient input (ADR 0007).

-- | Each connection receives onDidChange snapshots (packages/model/src/snapshot.ts):
-- revision, files, shapesVersion, movedIds, warnings, migrations, prefixes, export order, undo and dirty state,
-- the metamodel and counts (instances, report results, violations), and the last change:
-- its reason and, for an edit, undo or redo, its views, elements, shapes flag and layout flag.
-- The layout flag marks a change of placement geometry or style only. A panel skips a read that the change cannot affect.
-- A snapshot carries no Doc and no report.
data Snapshot
onDidChange :: Snapshot -> IO ()

-- 10. CLI --------------------------------------------------------------------

-- | scripts/catenary.mjs finds backend token files in $XDG_RUNTIME_DIR/catenary, else the OS temporary directory.
-- Each <pid>.json has mode 0600. A request is POST /catenary/cli with a random bearer token.
-- Keep the backend on localhost. eval runs arbitrary JavaScript in a window. The token is the access-control boundary.
-- Backend methods: status, model, rpc, exec (exec calls RPC execute with an EditCommand).
-- Window methods: commands, run, prompt, answer, ui, messages, eval. They need a connected window.
-- Backend choice: --port, else CATENARY_PORT, else the only running backend, else the one backend whose workspace contains
-- the current directory or is inside it. Otherwise the CLI fails and lists ports and workspaces. Files of dead PIDs are removed.
-- --window selects a window, else the last connection.
-- Output is JSON. Exit codes: 0 done, 1 failed, 2 usage or connection error, 3 waiting or timeout.
-- run and answer wait for completion, a prompt or the timeout (default 10 s). answer --cancel cancels a prompt.
-- Results hold status, prompts, notifications, a model summary and the changed flag.
-- Prompt adapters: dialogs, quick picks, input boxes, canvas pickers, inline inputs.
-- Limit: notification buttons and canvas drags have no adapter. Use exec for model effects, not for gesture checks.
-- status reports source and build staleness, backend restart need and window reload need. All must be false before a runtime check.
