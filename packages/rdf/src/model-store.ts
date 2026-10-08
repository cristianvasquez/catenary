// The model store: one RDF dataset (ModelGraph), shared by all diagram sessions and by the frontend. It coordinates the parts:
// the files on disk and the dataset read from them (workspace.ts), undo and the patch queue (history.ts), validation
// (validation-runner.ts), and the read models of the panels and editors, built for each request (ADR 0012: no shared Doc).
// All edits go through `execute` (one EditCommand = one transaction = one patch = one undo step). File operations run one at a time.
// Each change is written at once (ADR 0003). A shape edit that changes what the data must say adds a migration to the patch queue.

import {
    ChangeReason, CommandResult, Doc, ImportResult, ElementProperties, NS, SnapshotChange, ExplorerPath, ExplorerRow, EditCommand, MetamodelInfo, SelectionLinks, ModelSnapshot, OutlineNode, PREFIXES, Problem, SearchFacets, SearchResult, Violation, WorkspaceFiles, prefixesProblem,
    setPrefixes, ModelQueries, ViewGesture, GestureInfo, viewGesture, AppearanceData, appearanceData, Occurrence, occurrence, Showing, showing, ActionTarget, SelectionActions,
    Choices, DeletePlan, ElementRow, ModelSelection, NewLabelKind, RelationChoices, Selected, ShapesModel, View, deletePlan,
    elementRows, emptySelected, knownPredicates, neighborChoices, newLabel, relationChoices, shapeSourceChoices, viewProperties,
    TripleIndex, ViewFigures, idIri, viewFigures, FileContent
} from '@catenary/model';
import type { NamedNode, Quad } from '@rdfjs/types';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { FolderWatcher, OxigraphStore, SerialQueue, absolutePath, commitFiles, isInside, pathKey, portableRelative, readText as readDisk, resolveStored } from 'rdf-files';
import { ActionContext, selectionActions } from './actions';
import { executeCommand } from './commands';
import { ExplorerContent, ExplorerContext, Placements, explorerChildren, explorerElements, explorerPaths, placements } from './explorer';
import { LinkChoices, linkChoices } from './link-choices';
import { gone } from './ops';
import { OutlineSelection, outline } from './outline';
import { IMPORT_FOLDER, Placement, WORKSPACE_FILE, declaredPrefixes, enclosingWorkspace, parseRdf, serializeRdf, workspaceFileOf, sourceLine } from './files';
import { MODEL_GRAPH, ModelGraph, P, VALIDATION_GRAPH, Patch, cmp, isVocabularyQuad } from './graph';
import { History } from './history';
import { elementId, elementTerm, relationTriple } from './ids';
import { properties } from './properties';
import { formData, selectionLinks } from './queries';
import { readView, viewLabels } from './view-read';
import { readNotations, storeIndex } from './notations';
import { DocScope, fileReferences, hiddenNeighborCounts, instanceCount, instanceLabels, readWarnings, scopedDoc } from './scoped-doc';
import { movedIds } from './moved-ids';
import { Metamodel, emptyMetamodel, formShapes, metamodelFromQuads } from './shapes';
import { withCount } from './shape-ops';
import { ShapesIndex, shapesIndexOf } from './shapes-read';
import { skolemize } from './skolem';
import { rdf, termKey } from './terms';
import { reportProblems } from './validate';
import { ValidationRunner } from './validation-runner';
import { Workspace, createWorkspace, fileContent } from './workspace';
import { search } from './search';
import { selected } from './selection';

export type { ChangeReason };

export interface ModelChange {
    reason: ChangeReason;
    /** What the change touched (edit, undo, redo). Undefined: anything can have changed. */
    scope?: ChangeScope;
}

/** What a patch touched, as element ids. */
export interface ChangeScope {
    /** Views whose view graph changed. */
    views: string[];
    /** Instances in changed model statements, as subject or IRI object. */
    elements: string[];
    /** A shapes graph changed. */
    shapes: boolean;
    /** Only the geometry or the style of placements changed (LAYOUT_PREDICATES of view graphs). */
    layout: boolean;
}

/** Predicates of the geometry and the style of a placement: a change of these only moves, resizes or restyles what a view shows. */
const LAYOUT_PREDICATES = new Set(['x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide'].map(p => NS.view + p));

export type Listener = (change: ModelChange) => void;

/** A command refused because it changes protected files (absolute paths). */
function importedFailure(folder: string, files: string[]): CommandResult {
    const names = files.map(f => portableRelative(folder, f));
    const one = names.length === 1;
    return {
        ok: false, imported: files,
        error: `${names.join(', ')} ${one ? 'is an imported file' : 'are imported files'}: the change is not made. To change ${one ? 'it' : 'them'}, mark ${one ? 'it' : 'them'} as own in the file navigator.`
    };
}

export class ModelStore implements ModelQueries {
    protected graph = new ModelGraph(new OxigraphStore());
    protected metamodel: Metamodel = emptyMetamodel();
    warnings: string[] = [];
    /** The open workspace: its files and the dataset. Undefined: none is open. */
    protected ws?: Workspace;
    protected readonly history = new History();
    protected readonly validation = new ValidationRunner(
        () => ({ graph: this.graph, metamodel: this.metamodel, data: () => this.ws?.validationTriples() }), () => this.changed('validation'));
    shapesVersion = 0;
    revision = 0;

    /** Changes each time the dataset changes. Keys the caches below. */
    protected content = 0;
    protected cache: { content: number; placements?: Placements; instances?: number; explorer?: ExplorerContent } = { content: -1 };
    /** Old id -> new id, for the view and the instance whose IRI the last change changed. */
    protected movedIds: Record<string, string> = {};
    /** File operations, one at a time: a save and an open cannot overlap. */
    protected readonly fileQueue = new SerialQueue();

    protected readonly listeners = new Set<Listener>();

    /** Call `listener` after each change. */
    onDidChange(listener: Listener): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    protected cached<K extends 'placements' | 'instances' | 'explorer'>(k: K, compute: () => NonNullable<ModelStore['cache'][K]>): NonNullable<ModelStore['cache'][K]> {
        if (this.cache.content !== this.content) this.cache = { content: this.content };
        return (this.cache[k] ??= compute()) as NonNullable<ModelStore['cache'][K]>;
    }

    /** The shapes index of the shapes graphs and the SKOS vocabulary of the data file (cached per ModelGraph.shapesRevision). */
    protected shapesIndex(): ShapesIndex {
        return shapesIndexOf(this.graph);
    }

    /** A read model of the elements and views that one request needs (scoped-doc.ts). */
    protected scoped(scope: DocScope): Doc {
        return this.decorate(scopedDoc({ g: this.graph, shapes: this.shapesIndex().model }, scope));
    }

    /** The metamodel as JSON (without the shapes dataset). */
    get meta(): MetamodelInfo {
        const { source, classes, schemes, concepts } = this.metamodel;
        return { source, classes, schemes, concepts };
    }

    /** Read model of one view: the view and its instances and relations, from SPARQL rows of the view graph and the model (view-read.ts). */
    viewDoc(viewId: string): Doc {
        const shapes = this.shapesIndex().model;
        return this.decorate(readView(this.graph, viewId, shapes));
    }

    /** The triples of the store for the notation engine, built again after each change of the dataset. */
    protected figureData?: { content: number; index: TripleIndex };

    /** The figures of a view and their join with its placements (ADR 0014). Undefined: no such view. */
    viewFigures(viewId: string): ViewFigures | undefined {
        const iri = idIri(viewId);
        if (!iri) return undefined;
        if (this.figureData?.content !== this.content) this.figureData = { content: this.content, index: storeIndex(this.graph) };
        return viewFigures(this.figureData.index, readNotations(), iri);
    }

    /** For each instance card of the view: the number of related instances in and out that the view does not show (card halo). */
    hiddenNeighborCounts(view: View): Map<string, { in: number; out: number }> {
        return hiddenNeighborCounts(this.graph, this.shapesIndex().model, view);
    }

    /** Data graph of the SHACL form for an instance, as N-Triples. Empty if the instance does not exist. */
    formData(instanceId: string): string {
        const t = elementTerm(instanceId);
        return t?.termType === 'NamedNode' ? formData(this.graph, t) : '';
    }

    /** The Model explorer (ADR 0006): the rules of explorer.ts on this store; `currentView`: the view of the asking window. */
    protected explorerContext(currentView?: string): ExplorerContext {
        const idx = this.shapesIndex();
        const placed = this.cached('placements', () => placements(this.graph, idx.byTerm));
        return {
            g: this.graph, shapes: idx.model, meta: this.metamodel, byTerm: idx.byTerm, placements: placed, currentView, fileOf: t => this.ws?.filesOfSubject(t)[0],
            content: this.cached('explorer', () => ({}))
        };
    }

    /** Rows of a node key of the Model explorer; no key: the top folders. Nothing when no model is open. */
    explorerChildren(key?: string, currentView?: string): ExplorerRow[] {
        return this.file ? explorerChildren(this.explorerContext(currentView), key) : [];
    }

    /** Paths to the rows of an element in the Model explorer (Reveal). */
    explorerPaths(id: string): ExplorerPath[] {
        return this.file ? explorerPaths(this.explorerContext(), id) : [];
    }

    /** Labels of all views (view id → label), by SPARQL: the titles of the view editors (ADR 0007 step 5). */
    viewLabels(): Record<string, string> {
        return this.file ? viewLabels(this.graph) : {};
    }

    /** A gesture of a view editor (ADR 0007 step 5): why each candidate target is not one, and the facts of its element. */
    viewGesture(viewId: string, gesture: ViewGesture): GestureInfo {
        const doc = this.scoped({ elements: gestureElements(gesture), views: [viewId] });
        return viewGesture(doc, this.meta, doc.views[viewId], gesture);
    }

    /** The Appearance panel of view `viewId` for the selected `ids`; undefined: no such view. */
    appearance(viewId: string, ids: string[]): AppearanceData | undefined {
        const doc = this.viewDoc(viewId), view = doc.views[viewId];
        return view && appearanceData(doc, this.meta, view, ids);
    }

    /** The views that show the selected element (one instance or relation) of a selection of `view`. */
    occurrence(ids: string[], view?: string): Occurrence | undefined {
        return this.file ? occurrence(this.scoped({ elements: ids, views: [view], showing: true }), this.meta, ids, view) : undefined;
    }

    /** The views that show an element, and the box of each. */
    showing(id: string): Showing {
        return showing(this.scoped({ elements: [id], showing: true }), id);
    }

    /** The Outline of a view (ADR 0007): groups, cards and shown relations by SPARQL on the view graph; `selection` marks nodes. */
    outline(viewId: string, selection?: OutlineSelection): OutlineNode[] {
        if (!this.file) return [];
        const shapes = this.shapesIndex().model;
        return outline({ g: this.graph, meta: this.metamodel, shapes }, viewId, selection);
    }

    /** Element ids of the rows under a node key of the Model explorer, at any depth. */
    explorerElements(key: string): string[] {
        return this.file ? explorerElements(this.explorerContext(), key) : [];
    }

    /** Model properties panel (ADR 0007): the data of an element (properties.ts); no id: the counts of the store. */
    properties(id?: string): ElementProperties | undefined {
        if (!this.file) return undefined;
        const view = id === undefined ? undefined : viewProperties(this.viewDoc(id), id);
        if (view) return view;
        const idx = this.shapesIndex();
        const ws = this.ws!;
        return properties({
            g: this.graph, meta: this.metamodel, idx, fileOf: t => ws.filesOfSubject(t)[0],
            importedFiles: q => ws.filesOfQuad(q).filter(f => ws.isImported(f))
        }, id);
    }

    /** The Problems panel (ADR 0007): the results of the SHACL report graph, with the labels of their instances. */
    problems(): Problem[] {
        if (!this.file) return [];
        const idx = this.shapesIndex();
        return reportProblems(this.graph, this.metamodel, t => idx.byTerm.get(termKey(t)));
    }

    /** The Search panel and Find Element: the faceted search (search.ts, SPARQL). */
    search(facets: SearchFacets, limit: number): SearchResult {
        if (!this.file) return { hits: [], more: false, types: [] };
        return search({ g: this.graph, shapes: this.shapesIndex() }, facets, limit);
    }

    /**
     * The Links panel data of the selected ids of `view` (SPARQL, see `selectionLinks` in queries.ts): the elements, their views and
     * statements. Unknown ids give nothing.
     */
    links(ids: string[], view?: string): SelectionLinks {
        const idx = this.shapesIndex();
        return selectionLinks(this.graph, idx, this.scoped({ elements: ids, views: [view] }), this.metamodel, ids, view);
    }

    /** The actions that apply to a target, and the facts to run them (actions.ts, spec/ui-manifest.hs §4). */
    selectionActions(target: ActionTarget): SelectionActions {
        if (!this.file) return { actions: [], items: [], cards: [] };
        const ctx: ActionContext = {
            ...this.explorerContext(target.activeView),
            doc: this.scoped({ elements: target.ids, views: [target.view] }),
            viewOf: v => this.viewDoc(v).views[v],
            filesOf: id => this.filesOfElement(id)
        };
        return selectionActions(ctx, target);
    }

    /** Resolve selection from shared RDF queries, without the Doc. */
    selected(selection: ModelSelection): Selected {
        return this.file ? selected(this.graph, this.shapesIndex(), selection) : emptySelected();
    }

    /** One stored view, from its view graph (view-read.ts). */
    view(viewId: string): View | undefined {
        return this.file ? this.viewDoc(viewId).views[viewId] : undefined;
    }

    /** The read model of the shapes graphs. */
    shapes(): ShapesModel {
        return this.shapesIndex().model;
    }

    // The dialogs and pickers of the user actions (prompts.ts): the same rules for every caller.

    deletePlan(ids: string[]): DeletePlan {
        return deletePlan(this.scoped({ elements: ids, neighbors: true, showing: true }), this.metamodel, ids);
    }

    relationChoices(source: string, target: string): RelationChoices | undefined {
        return relationChoices(this.scoped({ elements: [source, target] }), this.metamodel, source, target);
    }

    neighborChoices(viewId: string, from: string, dir: 'out' | 'in'): Choices | undefined {
        return neighborChoices(this.scoped({ elements: [from], neighbors: true, views: [viewId] }), this.metamodel, viewId, from, dir);
    }

    shapeSourceChoices(viewId: string, from: string): Choices | undefined {
        return shapeSourceChoices(this.viewDoc(viewId), viewId, from);
    }

    /** The link picker (link-choices.ts): SPARQL scoped to the instance, its relation types, the view and the typed text. */
    linkChoices(dir: 'out' | 'in', from: string, viewId: string, text?: string): LinkChoices {
        if (!this.file) return undefined;
        return linkChoices({ g: this.graph, meta: this.metamodel, shapes: this.shapesIndex().model }, dir, from, viewId, text);
    }

    /** `newLabel` counts the labels of the elements of a kind: only the instances with an "unnamed" label can take a new one. */
    newLabel(kind: NewLabelKind, opts?: { classIri?: string; view?: string; base?: string }): string {
        const doc = this.scoped({ views: [opts?.view] });
        if (kind === 'instance' || kind === 'concept') {
            for (const [iri, label] of instanceLabels(this.graph)) {
                if (!label.startsWith('unnamed ')) continue;
                const id = elementId(rdf.namedNode(iri));
                doc.instances[id] = { id, label, uri: iri, types: [], fields: {} };
            }
        }
        return newLabel(doc, this.metamodel, kind, opts);
    }

    /** Predicates in use: the shapes, the metamodel, and the predicates of the statements of the instances (`knownPredicates`). */
    knownPredicates(): { iri: string; where: string }[] {
        const doc = this.scoped({});
        const id = 'data';
        doc.instances[id] = { id, label: '', uri: '', types: [], fields: Object.fromEntries(this.dataPredicates().map(p => [p, []])) };
        return knownPredicates(doc, this.metamodel);
    }

    /** The predicates of the instance statements, except rdf:type and rdfs:label, in order. */
    protected dataPredicates(): string[] {
        const labels = instanceLabels(this.graph);
        const found = new Set<string>();
        for (const r of this.graph.store.select(`SELECT DISTINCT ?s ?p WHERE { GRAPH <${this.graph.model.value}> { ?s ?p ?o } FILTER (isIRI(?s)) }`)) {
            if (labels.has(r.s.value) && r.p.value !== P.type.value && r.p.value !== P.label.value) found.add(r.p.value);
        }
        for (const [s, graph] of this.graph.vocabularySubjects()) {
            for (const q of this.graph.match(rdf.namedNode(s), null, null, graph)) if (!q.predicate.equals(P.type) && !q.predicate.equals(P.label)) found.add(q.predicate.value);
        }
        return [...found].sort(cmp);
    }

    /** The classes of the shapes and the types of the instances: what a typed class name resolves to (`classIri`). */
    knownClasses(): { iri: string; name?: string }[] {
        const types = new Set<string>();
        for (const r of this.graph.store.select(`SELECT DISTINCT ?t WHERE { GRAPH <${this.graph.model.value}> { ?s a ?t } FILTER (isIRI(?s) && ?s != <${MODEL_GRAPH}>) }`)) types.add(r.t.value);
        for (const [s, graph] of this.graph.vocabularySubjects()) for (const t of this.graph.objects(rdf.namedNode(s), P.type, graph)) types.add(t.value);
        return [...this.metamodel.classes.map(c => ({ iri: c.iri, name: c.name })), ...[...types].sort(cmp).map(iri => ({ iri }))];
    }

    /** Labels of the instances that are not members of the collection box `collection` of `view` (for "+ member"). */
    memberOptions(viewId: string, collection: string): string[] {
        const view = this.viewDoc(viewId).views[viewId];
        const members = new Set(view?.boxes.find(b => b.kind === 'collection' && b.id === collection)?.kind === 'collection'
            ? (view.boxes.find(b => b.id === collection) as { members: string[] }).members : []);
        return [...new Set([...instanceLabels(this.graph)].filter(([iri]) => !members.has(elementId(rdf.namedNode(iri)))).map(([, label]) => label))].sort();
    }

    /** The instances with the label or IRI `text`. */
    instancesNamed(text: string): string[] {
        return [...instanceLabels(this.graph)].filter(([iri, label]) => label === text || iri === text).map(([iri]) => elementId(rdf.namedNode(iri)));
    }

    elementRows(ids: string[], viewId?: string): ElementRow[] {
        return elementRows(this.scoped({ elements: ids, views: [viewId] }), this.metamodel, ids, viewId);
    }

    /** The instances of `ids` without a card in any view, and the relations of `ids` without a placed edge in any view. */
    unplaced(ids: string[]): string[] {
        const doc = this.scoped({ elements: ids, showing: true });
        const views = Object.values(doc.views);
        return ids.filter(id => doc.instances[id] ? !views.some(v => v.boxes.some(b => b.kind === 'card' && b.element === id))
            : !!doc.relations[id] && !views.some(v => v.edges.some(e => e.id && e.relation === id)));
    }

    /**
     * What a file holds that Catenary edits, from its content. With views: the workspace that reads it, the open one when it has the
     * file as a view file, else the nearest folder above with one workspace file.
     */
    async fileContent(file: string): Promise<FileContent> {
        const p = absolutePath(file);
        const c = await fileContent(p);
        const views = c.views.map(v => ({ id: elementId(rdf.namedNode(v.iri)), label: v.label }));
        const own = c.views.some(v => { const f = this.ws?.viewFile(v.iri); return !!f && pathKey(f.path) === pathKey(p); });
        const workspaceFile = views.length ? (own && this.ws ? this.ws.path : await enclosingWorkspace(p)) : undefined;
        return { workspace: c.workspace, views, ...(workspaceFile ? { workspaceFile } : {}), ...(c.error ? { error: c.error } : {}) };
    }

    /** The subject term of an element id (a property shape: its term; a logical constraint: its node shape), or the triple of a relation. */
    protected statementsOf(id: string): Quad[] {
        const triple = relationTriple(id);
        if (triple) return this.graph.match(triple.s, triple.p, triple.o);
        const idx = this.shapesIndex();
        const t = idx.property.get(id)?.term ?? idx.constraint.get(id)?.owner ?? elementTerm(id);
        if (!t) return [];
        const own = this.graph.match(t).filter(q => !q.graph.equals(rdf.namedNode(VALIDATION_GRAPH)));
        return own.length ? own : this.graph.match(null, null, t).filter(q => !q.graph.equals(rdf.namedNode(VALIDATION_GRAPH)));
    }

    /**
     * The files with statements of an element (Go to Source, spec 0.4): the triples with the element as subject; a relation: its
     * triple; no such triples: the triples with it as object. Most statements first.
     */
    filesOfElement(id: string): string[] {
        const count = new Map<string, number>();
        for (const q of this.statementsOf(id)) for (const f of this.ws?.filesOfQuad(q) ?? []) count.set(f, (count.get(f) ?? 0) + 1);
        return [...count].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([f]) => f);
    }

    /**
     * Go to Source: every file with statements of an element, and the line of the element in each (the file on disk: unsaved changes
     * are not in it). The line is of the subject IRI; a property shape without its own line: the line of its node shape.
     */
    async sources(id: string): Promise<{ path: string; line?: number }[]> {
        const idx = this.shapesIndex();
        const subject = relationTriple(id)?.s ?? idx.property.get(id)?.term ?? elementTerm(id);
        const owner = idx.property.get(id)?.owner ?? idx.constraint.get(id)?.owner;
        const out: { path: string; line?: number }[] = [];
        for (const file of this.filesOfElement(id)) {
            let line: number | undefined;
            try {
                const text = await fs.readFile(file, 'utf8');
                line = (subject?.termType === 'NamedNode' ? sourceLine(text, subject.value) : undefined) ?? (owner ? sourceLine(text, owner.value) : undefined);
            } catch { /* not on disk yet */ }
            out.push({ path: file, line });
        }
        return out;
    }

    protected scopeOf(patch: Patch): ChangeScope {
        const views = new Set<string>(), elements = new Set<string>();
        let shapes = false, layout = true;
        for (const { quad: q } of patch) {
            if (this.graph.isShapesGraph(q.graph)) {
                shapes = true;
                layout = false;
                continue;
            }
            if (!q.graph.equals(this.graph.model)) {
                if (q.graph.termType === 'NamedNode') views.add(elementId(q.graph));
                if (!LAYOUT_PREDICATES.has(q.predicate.value)) layout = false;
                continue;
            }
            layout = false;
            // A concept scheme, concept or collection of the data file: the value set cards and the metamodel change too.
            if (isVocabularyQuad(q)) shapes = true;
            for (const t of [q.subject, q.object]) if (t.termType === 'NamedNode') elements.add(elementId(t as NamedNode));
        }
        return { views: [...views], elements: [...elements], shapes, layout: layout && patch.length > 0 };
    }

    /** What the read of a view does not know: the file of each instance, and the path and state of each file reference. */
    protected decorate(doc: Doc): Doc {
        // The file of each instance: the file with most of its statements.
        for (const i of Object.values(doc.instances)) {
            const f = this.ws?.filesOfSubject(rdf.namedNode(i.uri))[0];
            if (f) i.file = f; else delete i.file;
        }
        // File references: the absolute path (from the folder of the view file), and whether the file is on disk.
        for (const v of Object.values(doc.views)) {
            const dir = path.dirname(this.ws?.viewFile(v.uri)?.path ?? path.join(this.folder, 'views', 'x'));
            for (const b of v.boxes) {
                if (b.kind !== 'reference' || !b.file) continue;
                b.path = resolveStored(dir, b.file);
                b.broken = !existsSync(b.path);
            }
        }
        return doc;
    }

    /** The files that file references name, with their state on disk (for the watcher). */
    protected referencedFiles(): string {
        return fileReferences(this.graph).map(({ view, file }) => {
            const p = resolveStored(path.dirname(this.ws?.viewFile(view)?.path ?? path.join(this.folder, 'views', 'x')), file);
            return `${p}:${existsSync(p)}`;
        }).sort().join('\n');
    }

    get canUndo(): boolean { return this.history.canUndo; }
    get canRedo(): boolean { return this.history.canRedo; }

    get violations(): Violation[] { return this.validation.violations; }

    /** Validate the model now, without the delay after a change. */
    validate(): Promise<void> { return this.validation.now(); }

    /** The last change (ModelSnapshot.change). */
    protected lastChange?: SnapshotChange;

    snapshot(): ModelSnapshot {
        return {
            revision: this.revision,
            ...(this.lastChange ? { change: this.lastChange } : {}),
            file: this.file,
            files: this.files,
            shapesVersion: this.shapesVersion,
            meta: this.meta,
            counts: {
                instances: this.cached('instances', () => instanceCount(this.graph)),
                results: this.violations.length,
                violations: this.violations.filter(v => v.severity === 'Violation').length
            },
            warnings: this.warnings,
            migrations: this.history.migrations.map(m => withCount(this.graph, m)),
            movedIds: this.movedIds,
            prefixes: { table: { ...PREFIXES }, stored: !!this.ws?.prefixes },
            dirty: this.dirty,
            canUndo: this.canUndo,
            canRedo: this.canRedo
        };
    }

    // ------------------------------------------------------------ edits

    /** Run a command as one transaction. On an error, the dataset does not change. */
    execute(command: EditCommand): CommandResult {
        const ws = this.ws;
        if (!ws) return { ok: false, error: 'No model is open.' };
        if (command.kind === 'addFileReference') {
            // The file reference keeps the path relative to its view file (the folder can move).
            const f = ws.viewFile(elementTerm(command.view)?.value ?? '');
            if (!f) return gone('view', command.view);
            command = { ...command, file: portableRelative(path.dirname(f.path), path.resolve(this.folder, command.file)) };
        }
        if (command.kind === 'createView' && command.folder) {
            const folder = path.resolve(this.folder, command.folder);
            if (folder !== this.folder && !isInside(this.folder, folder)) return { ok: false, error: `The folder ${command.folder} is not in the workspace folder.` };
            ws.newViewFolder = folder;
        }
        if (command.kind === 'createView' && command.folder && ws.isImported(path.join(ws.newViewFolder!, 'view.view.trig'))) {
            ws.newViewFolder = undefined;
            return { ok: false, error: `The folder ${command.folder} is for imported files.` };
        }
        if (command.kind === 'createView' && command.file) {
            const file = path.resolve(this.folder, command.file);
            const problem = ws.newViewFileProblem(file) ?? (ws.isImported(file) ? `${command.file} is an imported file.` : undefined);
            if (problem) { ws.newViewFolder = undefined; return { ok: false, error: problem }; }
            ws.newViewFile = file;
        }
        const shapesBefore = this.shapesIndex(), revision = this.graph.shapesRevision;
        // Imported files (manifest ws:imported): a command that changes their statements fails as a whole (no partial change).
        const { result: r, patch } = this.graph.transact((g): ReturnType<typeof executeCommand> | CommandResult => {
            const r = executeCommand(g, this.metamodel, command);
            const files = r.ok ? ws.importedChanges(g.changes()) : [];
            return files.length ? importedFailure(this.folder, files) : r;
        });
        if (!r.ok) { ws.newViewFolder = ws.newViewFile = undefined; return r; }
        if (patch.length) {
            this.commitNotes.push(command.kind);
            this.track(patch);
        }
        this.history.record(patch, command.kind === 'migrateData' ? command.migration.id : undefined, this.graph.proposed);
        this.graph.proposed = [];
        if (patch.length) {
            this.contentChanged(patch, this.graph.shapesRevision !== revision ? shapesBefore : undefined);
            this.changed('edit', patch);
        }
        ws.newViewFolder = ws.newViewFile = undefined;
        const v = 'value' in r ? r.value : undefined;
        if (Array.isArray(v)) return { ok: true, id: v[0], ids: v };
        return { ok: true, id: typeof v === 'string' ? v : undefined };
    }

    undo(): CommandResult { return this.replay('undo'); }
    redo(): CommandResult { return this.replay('redo'); }

    /**
     * Apply the last patch of the undo (backwards) or redo stack. The patch queue goes back to its state of that step. A step that
     * changes a file that is imported now is refused, as an edit is (the step stays on its stack).
     */
    protected replay(reason: 'undo' | 'redo'): CommandResult {
        const next = this.history.peek(reason);
        if (!next || !this.ws) return { ok: true };
        const applied: Patch = reason === 'undo' ? [...next.patch].reverse().map(c => ({ op: c.op === 'add' ? 'remove' : 'add', quad: c.quad })) : next.patch;
        const files = this.ws.importedChanges(applied);
        if (files.length) return importedFailure(this.folder, files);
        const step = this.history.take(reason)!;
        const shapesBefore = this.shapesIndex(), revision = this.graph.shapesRevision;
        this.graph[reason](step.patch);
        this.track(applied);
        this.contentChanged(applied, this.graph.shapesRevision !== revision ? shapesBefore : undefined);
        this.changed(reason, step.patch);
        return { ok: true };
    }

    /** Remove an entry of the patch queue without applying it. Not an undo step. */
    dismissMigration(id: string): void {
        if (this.history.dismiss(id)) this.changed('queue');
    }

    /** Keep the files of the statements in step with a patch (workspace.ts). */
    protected track(patch: Patch): void {
        this.ws?.track(patch);
        this.content++;
    }

    /**
     * The dataset changed. Validation depends on the model graph only: a layout change does not start it.
     * `patch`: the changes in the order applied. `shapesBefore`: the shapes index before them, when they changed the shapes or the
     * vocabulary (ModelGraph.shapesRevision); no patch: anything can have changed.
     */
    protected contentChanged(patch?: Patch, shapesBefore?: ShapesIndex): void {
        const shapes = !patch || !!shapesBefore;
        if (shapes) this.rebuildMetamodel();
        this.content++;
        this.movedIds = patch ? movedIds(this.graph, patch, shapesBefore ? { before: shapesBefore, after: this.shapesIndex() } : undefined) : {};
        // A view graph whose IRI changed stays in its view file. (Other moved ids, such as property shapes, are not graphs.)
        for (const [from, to] of Object.entries(this.movedIds)) this.ws?.moveViewFile(elementTerm(from)?.value ?? '', elementTerm(to)?.value ?? '');
        this.ws?.assignViewFiles();
        if (shapes || patch.some(c => c.quad.graph.equals(this.graph.model))) this.validation.invalidate();
    }

    protected changed(reason: ChangeReason, patch?: Patch): void {
        if (reason !== 'edit' && reason !== 'undo' && reason !== 'redo') this.movedIds = {};
        this.revision++;
        if (this.ws && reason !== 'disk') this.referencedState = this.referencedFiles();
        const scope = patch && this.scopeOf(patch);
        this.lastChange = { reason, ...scope };
        for (const l of [...this.listeners]) l({ reason, scope });
        // Disk is the source of truth (ADR 0003): every change is written at once.
        if (reason === 'undo' || reason === 'redo' || reason === 'files') this.commitNotes.push(reason);
        if (reason === 'edit' || reason === 'undo' || reason === 'redo' || reason === 'files') this.queueWrite();
        if (reason === 'load' || reason === 'files' || reason === 'shapes') this.watch();
    }

    protected writeQueued = false;
    /** What the next commit contains: command kinds, undo, redo, files. */
    protected commitNotes: string[] = [];
    /** The last write error; it shows in the warnings until a write succeeds. */
    protected writeError?: string;

    /** Queue a write of the changed files: one write for all changes that come before it runs. */
    protected queueWrite(): void {
        if (!this.ws || this.writeQueued || this.ws.gone) return;
        this.writeQueued = true;
        void this.serial(async () => {
            this.writeQueued = false;
            await this.write();
        });
    }

    /** Write the changed files and commit them. A failure shows in the warnings until a write succeeds. */
    protected async write(): Promise<CommandResult> {
        const ws = this.ws;
        const r: CommandResult = ws ? await ws.save() : { ok: false, error: 'No workspace is open.' };
        if (r.ok) {
            this.content++;
            this.changed('save');
        }
        const notes = [...new Set(this.commitNotes.splice(0))];
        const warningCount = this.warnings.length;
        const files = ws?.committable() ?? [];
        const error = r.ok ? await commitFiles(files, `Catenary: ${notes.slice(0, 5).join(', ')}${notes.length > 5 ? ', …' : ''}`) : `Not written: ${r.error}`;
        if (r.ok && !error) ws!.written = [];
        if (error) this.commitNotes.unshift(...notes);
        if (error !== this.writeError || this.warnings.length !== warningCount) {
            this.warnings = [...this.warnings.filter(w => w !== this.writeError), ...(error ? [error] : [])];
            this.writeError = error;
            this.changed('save');
        }
        return r;
    }

    /** Resolves when the queued writes are done. */
    idle(): Promise<void> {
        return this.fileQueue.idle();
    }

    // ------------------------------------------------------------ changes on disk (ADR 0003 step 5)

    /** Watch the files of the workspace (tests that call `syncFromDisk` themselves set it to false). */
    watching = true;
    /** `referencedFiles()` at the last change: a difference is a file reference that changed state on disk. */
    protected referencedState = '';
    protected readonly watcher = new FolderWatcher(() => void this.serial(() => this.syncFromDisk()));

    /**
     * Watch the folder of the workspace file and its subfolders. An event starts `syncFromDisk` after 150 ms without events (an editor
     * writes a file in more than one step). Hidden files and folders (.git) and Catenary's own temporary files are ignored; its own writes
     * change nothing (the text on disk is the text it wrote).
     */
    protected watch(): void {
        if (!this.ws || !this.watching || this.ws.gone) return this.close();
        this.watcher.watch(this.folder);
    }

    /** Stop watching the files. */
    close(): void {
        this.watcher.close();
    }

    /**
     * Read again the files that another program changed (the text on disk is not the text that Catenary last read or wrote), and the
     * files that are new or removed in the folder. A changed workspace file opens the workspace again. The disk wins over a write that
     * is pending. No undo across it. Returns the names of the files read.
     */
    async syncFromDisk(): Promise<string[]> {
        const ws = this.ws;
        if (!ws) return [];
        const text = await readDisk(ws.path);
        if (text === undefined && ws.workspace.text !== undefined) {
            // The workspace file (or its folder) is gone: keep the model as it is, stop watching, say it once.
            const note = `${path.basename(ws.path)} was removed or moved on disk: the files are not read or written until the workspace is opened again.`;
            this.close();
            ws.gone = true;
            if (!this.warnings.includes(note)) {
                this.warnings = [...this.warnings, note];
                this.changed('files');
            }
            return [];
        }
        // Also a workspace file that another program made (the folder was opened without one).
        if (text !== undefined && text !== ws.workspace.text) {
            const name = path.basename(ws.path);
            const r = await this.doOpen(ws.path);
            this.warnings = [...this.warnings, r.ok ? `${name} changed on disk: the workspace was opened again.` : `${name} changed on disk and cannot be opened: ${r.error}`];
            this.changed('files');
            return [name];
        }
        const { read, notes, unmounted } = await ws.readChanges();
        if (!read.length && !notes.length) {
            // Only a referenced file appeared or disappeared: new doc, no write.
            if (this.referencedFiles() !== this.referencedState) {
                this.content++;
                this.referencedState = this.referencedFiles();
                this.changed('disk');
            }
            return [];
        }
        // The failed write of a file that was read again is not pending any more; a new failure shows again.
        const notRead = (w: string) => [...unmounted].some(n => w.startsWith(`${n}: not read: `));
        this.warnings = [...this.warnings.filter(w => w !== this.writeError && !notRead(w) && !/ changed on disk: read again| was removed on disk| is new on disk/.test(w)), ...notes];
        this.writeError = undefined;
        await ws.recordUncommitted(read.map(f => path.resolve(this.folder, f)));
        ws.syncShapesTarget();
        this.filesChanged('files');
        return read;
    }

    // ------------------------------------------------------------ files

    /** Run file operations one at a time, so that a save and an open cannot overlap. */
    protected serial<T>(fn: () => Promise<T>): Promise<T> {
        return this.fileQueue.run(fn);
    }

    /** Path of the primary workspace file. */
    get file(): string | undefined {
        return this.ws?.path;
    }

    /** The folder of the workspace file: the model files are in it and its subfolders. */
    get folder(): string {
        return this.ws?.folder ?? '';
    }

    get files(): WorkspaceFiles {
        return this.ws ? this.ws.info(this.graph.views().map(v => elementId(v))) : { files: [], views: [] };
    }

    /** The file for new subjects when "near" finds no file (workspace.ts). */
    get defaultFile(): string | undefined {
        return this.ws?.defaultFile;
    }

    get dirty(): boolean {
        return this.ws?.dirty ?? false;
    }

    /**
     * Open a workspace file, or a folder (`workspaceFileOf`). A folder without a workspace file opens with the default settings; its
     * `workspace.trig` is written at the first change of a setting. That path while it is not on disk (a recent entry) is its folder.
     */
    open(workspacePath: string): Promise<CommandResult> {
        return this.serial(async () => {
            let given = absolutePath(workspacePath);
            if (path.basename(given) === WORKSPACE_FILE && !existsSync(given) && existsSync(path.dirname(given))) given = path.dirname(given);
            const target = await workspaceFileOf(given);
            if ('error' in target) return { ok: false, error: target.error };
            // The content decides, not the name: a view file is part of a workspace, not one.
            const content = existsSync(target.file) ? await fileContent(target.file) : undefined;
            if (content?.viewFile && !content.workspace) return { ok: false, error: `${path.basename(target.file)} is a view file. Open its workspace, then open the view.` };
            return this.doOpen(target.file, target.file !== given);
        });
    }

    /** `ofFolder`: the folder was given; a workspace file that is not on disk is the default manifest. */
    protected async doOpen(primaryPath: string, ofFolder = false): Promise<CommandResult> {
        const r = await Workspace.open(primaryPath, ofFolder, { content: () => this.content, note: text => this.note(text) });
        if ('error' in r) return { ok: false, error: r.error };
        if (this.ws) this.ws.retired = true;
        this.ws = r.workspace;
        this.graph = r.workspace.graph;
        this.history.clear();
        this.validation.reset();
        this.contentChanged();
        this.warnings = [...r.warnings, ...readWarnings(this.graph, this.shapesIndex().model)];
        await this.ws.recordUncommitted();
        this.changed('load');
        return { ok: true };
    }

    /** Create a workspace (`createWorkspace`) and open it. */
    create(workspacePath: string, placement: Partial<Placement> = {}): Promise<CommandResult> {
        return this.serial(async () => {
            const r = await createWorkspace(workspacePath, placement);
            return 'error' in r ? { ok: false, error: r.error } : this.doOpen(r.file);
        });
    }

    /** The files changed on disk: the dataset may have changed. No undo across it. */
    protected filesChanged(reason: ChangeReason): void {
        this.history.clear();
        this.contentChanged();
        this.changed(reason);
    }

    /** The metamodel from the shapes graphs and the SKOS vocabulary of the model graph. */
    protected rebuildMetamodel(): void {
        const shapes = this.graph.shapesTriples();
        // The vocabulary (concept schemes, concepts) is part of the metamodel: the targets of scheme properties.
        const vocabulary = this.graph.vocabularyQuads().map(q => rdf.quad(q.subject, q.predicate, q.object));
        const sources = this.ws?.shapeSources() ?? [];
        this.metamodel = shapes.length || vocabulary.length ? metamodelFromQuads([...shapes, ...vocabulary], sources.join(', ')) : emptyMetamodel();
        this.shapesVersion++;
    }

    /** Replace the prefix table. It goes to the manifest of the primary workspace file (saved with it). No undo step. */
    setPrefixes(prefixes: Record<string, string>): Promise<CommandResult> {
        return this.serial(async () => {
            if (!this.ws) return { ok: false, error: 'No model is open.' };
            const problem = prefixesProblem(prefixes);
            if (problem) return { ok: false, error: problem };
            this.ws.prefixes = { ...prefixes };
            setPrefixes(this.ws.prefixes);
            this.graph.shapesChanged();
            // Compact IRIs in the read models: labels, paths, "Not mapped" rows.
            this.rebuildMetamodel();
            this.content++;
            this.changed('files');
            return { ok: true };
        });
    }

    /**
     * Change the settings of the manifest (ADR 0004): the default file and the file of each kind (a model file, or a new RDF file in
     * the workspace folder; a kind: also "near"), the exclude globs. Written at once. A new exclude glob reads the files again. No undo step.
     */
    setSettings(settings: { defaultFile?: string; placement?: Partial<Placement>; exclude?: string[]; imported?: string[] }): Promise<CommandResult> {
        return this.serial(() => this.applySettings(settings));
    }

    protected async applySettings(settings: { defaultFile?: string; placement?: Partial<Placement>; exclude?: string[]; imported?: string[] }): Promise<CommandResult> {
        const ws = this.ws;
        if (!ws) return { ok: false, error: 'No workspace is open.' };
        // A file to mark as imported must be on disk as Catenary has it: the write gives blank nodes their IRIs in the file.
        if (settings.imported?.some(g => !ws.importedGlobs.includes(g)) && ws.dirty) {
            this.commitNotes.push('before import mark');
            await this.write();
        }
        const r = ws.applySettings(settings);
        if ('error' in r) return { ok: false, error: r.error };
        if (r.reread) {
            this.content++;
            await this.write();
            return this.doOpen(ws.path);
        }
        ws.syncShapesTarget();
        this.content++;
        this.changed('files');
        return { ok: true };
    }

    /**
     * Mark one file as imported or as own (a path relative to the workspace folder, or absolute): add its path to the imported globs,
     * or remove the globs that are its path. A file that another glob still matches stays imported (error that names the glob).
     */
    setImported(file: string, on: boolean): Promise<CommandResult> {
        return this.serial(async () => {
            const ws = this.ws;
            if (!ws) return { ok: false, error: 'No workspace is open.' };
            const abs = path.resolve(this.folder, file);
            if (!isInside(this.folder, abs)) return { ok: false, error: `${file}: the file must be in the folder of the workspace file.` };
            const rel = portableRelative(this.folder, abs);
            const globs = ws.importedGlobs;
            if (on) return ws.isImported(abs) ? { ok: true } : this.applySettings({ imported: [...globs, rel] });
            const r = await this.applySettings({ imported: globs.filter(g => g !== rel) });
            if (!r.ok) return r;
            const glob = ws.importedGlobs.find(g => ws.isImported(abs, [g]));
            return glob ? { ok: false, error: `${rel} stays imported by the glob "${glob}". Remove the glob in the Workspace settings.` } : r;
        });
    }

    /**
     * Import RDF files (§2.6). A model file or view file of the workspace is marked as imported where it is (no copy). Another file gets
     * a Turtle copy with IRIs for its blank nodes in imported/<name>.ttl (-2, … when taken), marked as imported. The prefixes of the
     * files that the workspace table does not have are added; a prefix whose name or namespace the table has with another value is not
     * (a note). All files or none. With copies, the workspace is read again once: no undo across it.
     */
    importFiles(sources: string[]): Promise<ImportResult> {
        return this.serial(async (): Promise<ImportResult> => {
            const ws = this.ws;
            if (!ws) return { ok: false, error: 'No workspace is open.' };
            if (!sources.length) return { ok: false, error: 'No file to import.' };
            // Read all files first: a file that cannot be read imports nothing.
            const reads: { name: string; text: string; quads?: Quad[]; source: string; inPlace?: string }[] = [];
            for (const source of sources) {
                const name = path.basename(source);
                const inPlace = ws.knownFile(path.resolve(source));
                try {
                    const text = await fs.readFile(source, 'utf8');
                    const quads = inPlace ? undefined : await parseRdf(text, source);
                    if (quads && !quads.length) return { ok: false, error: `${name}: not imported: the file has no statements.` };
                    reads.push({ name, text, quads, source, inPlace });
                } catch (e) {
                    return { ok: false, error: `${name}: not imported: ${(e as Error).message}` };
                }
            }
            const table = { ...PREFIXES }, added: string[] = [], skipped = new Set<string>();
            for (const r of reads) {
                for (const [prefix, ns] of Object.entries(declaredPrefixes(r.text, r.source))) {
                    if (table[prefix] === ns) continue;
                    if (!prefix || table[prefix] !== undefined || Object.values(table).includes(ns)) { skipped.add(prefix); continue; }
                    table[prefix] = ns;
                    added.push(prefix);
                }
            }
            const names = reads.map(r => r.name).join(', ');
            if (added.length && prefixesProblem(table)) return { ok: false, error: `${names}: not imported: ${prefixesProblem(table)}` };
            const before = { prefixes: ws.prefixes, table: { ...PREFIXES }, imported: ws.importedGlobs };
            // Files of the workspace: marked where they are. The write gives their blank nodes IRIs first (as Mark as Imported).
            const own = reads.filter(r => r.inPlace && !ws.isImported(r.inPlace)).map(r => portableRelative(this.folder, r.inPlace!));
            if (own.length) {
                if (ws.dirty) {
                    this.commitNotes.push('before import mark');
                    await this.write();
                }
                const marked = ws.applySettings({ imported: [...before.imported, ...own] });
                if ('error' in marked) return { ok: false, error: `${names}: not imported: ${marked.error}` };
            }
            const note = () => {
                if (skipped.size) this.note(`${names}: prefixes not added (the workspace has the name or the namespace with another value): ${[...skipped].map(p => `${p}:`).join(' ')}`);
            };
            if (added.length) { ws.prefixes = table; setPrefixes(table); }
            const copies = reads.filter(r => !r.inPlace);
            if (!copies.length) {
                // No new file: the store keeps its statements; the prefixes change the read models (as setPrefixes).
                if (added.length) { this.graph.shapesChanged(); this.rebuildMetamodel(); }
                ws.syncShapesTarget();
                this.commitNotes.push(`import ${names}`);
                this.content++;
                this.changed('files');
                note();
                return { ok: true, files: reads.map(r => r.inPlace!), prefixes: added };
            }
            const folder = path.join(this.folder, IMPORT_FOLDER);
            const targets = new Map<typeof reads[number], string>();
            for (const r of copies) {
                const base = r.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'imported';
                let target = path.join(folder, `${base}.ttl`);
                for (let i = 2; existsSync(target) || [...targets.values()].includes(target); i++) target = path.join(folder, `${base}-${i}.ttl`);
                targets.set(r, target);
            }
            const undo = async (error: string): Promise<ImportResult> => {
                for (const t of targets.values()) await fs.rm(t, { force: true });
                ws.prefixes = before.prefixes;
                setPrefixes(before.table);
                ws.applySettings({ imported: before.imported });
                return { ok: false, error: `${names}: not imported: ${error}` };
            };
            try {
                await fs.mkdir(folder, { recursive: true });
                for (const [r, target] of targets) {
                    // The default graph: a model file has no graph names (open.md STORE1).
                    const triples = skolemize(r.quads!.map(q => rdf.quad(q.subject, q.predicate, q.object))).quads;
                    await fs.writeFile(target, await serializeRdf(triples, target), { flag: 'wx' });
                }
            } catch (e) {
                return undo((e as Error).message);
            }
            ws.applySettings({ imported: [...ws.importedGlobs, ...[...targets.values()].map(t => portableRelative(this.folder, t))] });
            ws.written.push(...targets.values());
            this.commitNotes.push(`import ${names}`);
            this.content++;
            const w = await this.write();
            if (!w.ok) return undo(w.error);
            const opened = await this.doOpen(ws.path);
            if (!opened.ok) return opened;
            note();
            return { ok: true, files: reads.map(r => r.inPlace ?? targets.get(r)!), prefixes: added };
        });
    }

    /** Write the files that are not written yet (after a failed write), and commit them. Normally there is nothing to write. */
    save(): Promise<CommandResult> {
        return this.serial(() => this.write());
    }

    protected note(text: string): void {
        if (!this.warnings.includes(text)) this.warnings.push(text);
        this.notes.push(text);
        console.warn(`[catenary] ${text}`);
    }

    /** Notes of the writes, for the tests and the log. */
    readonly notes: string[] = [];

    /** The shapes for the instance form (see `formShapes`), as N-Triples. */
    shapesText(): string {
        return formShapes(this.metamodel).toString();
    }
}

/** The elements of a gesture whose records `viewGesture` reads: its source, relation, row or property, and its candidate cards. */
function gestureElements(g: ViewGesture): string[] {
    switch (g.kind) {
        case 'reconnect': return [g.relation, ...g.cards];
        case 'link': case 'linkIn': case 'shapeLink': case 'shapeLinkIn': return [g.source, ...g.cards];
        case 'arrow': return [g.source];
        case 'row': return [g.row, ...g.cards];
        case 'logic': return [g.from, ...g.ids];
        case 'target': return [g.property, ...g.cards];
        case 'element': return [g.id];
        case 'broader': return [];
    }
}
