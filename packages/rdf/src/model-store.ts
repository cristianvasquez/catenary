import { TargetMatch } from '@catenary/shacl/common';
import { PanelReads } from './panel-reads';
import { applicabilityOf } from './queries';
// The model store: one RDF dataset (ModelGraph), shared by all diagram sessions and by the frontend. It coordinates the parts:
// the files on disk and the dataset read from them (settings.ts, loader.ts, reconciler.ts, placement.ts, saver.ts), undo and the patch queue (history.ts), validation
// (validation-runner.ts), the read models of the panels, built for each request (ADR 0012: no Doc of the whole dataset), and the
// reads that it keeps across changes and brings up to date from each patch (change.ts, manifest §11.3).
// All edits go through `execute` (one EditCommand = one transaction = one patch = one undo step) or `executeBatch` (several commands,
// one transaction). File operations run one at a time.
// Each change is written at once (ADR 0003). A shape edit that changes what the data must say adds a migration to the patch queue.

import {
    BatchResult, ChangeReason, CommandResult, Derivation, Doc, EditCommand, ImportResult, MetamodelInfo, MigrationChange, ModelSnapshot, PREFIXES, SnapshotChange,
    MODEL_QUERIES, ModelQueries, QUERY_ID_PARAMS, TripleRef, ValidationMode, View, ViewFigures, Violation, WorkspaceFiles, canonicalId, cardOf, idIri, isTripleRef, prefixesProblem, setPrefixes
} from '@catenary/model';
import * as path from 'path';
import { OxigraphStore, QuadStore, SerialQueue, TRAP_MESSAGE, TrapGuard, isInside, oxigraphMemoryBytes, portableRelative } from 'rdf-files';
import type { StoreTrap } from 'rdf-files';
import { authoringMetamodel } from './authoring';
import { commandShapeError, executeCommand, mapCommandIds } from './commands';
import { Placement, decorateFileReferences, referencedFiles } from './files';
import { ChangeScope, Classified, REPORT_GRAPH, classify, keepsReads, mergeRecords, tierOf } from './change';
import { GraphChange, ModelGraph, Patch } from './graph';
import { History } from 'rdf-core';
import { elementId, elementTerm, relationTriple } from './ids';
import { importFiles } from './import';
import { Loader, openWorkspace, readImportSources, resolveOpenTarget } from './loader';
import { movedIds, viewsChanged } from './moved-ids';
import { viewFiguresOf } from './notations';
import { gone } from './ops';
import { filesOfSubjects, placeChanges, transfer } from './placement';
import { Reconciler } from './reconciler';
import { ImportCopies, Saver, Writer } from './saver';
import { DatasetWarnings, DocScope, NeighborCount, fileReferences, hiddenNeighborCounts, instanceCount, scopedDoc, updateHiddenNeighborCounts } from './scoped-doc';
import { Settings, createWorkspace } from './settings';
import { withCount } from './shape-ops';
import { Metamodel, buildVocabulary, emptyMetamodel, shapesTriples, vocabularyQuads } from './shapes';
import { ShapesIndex, shapesIndexOf } from './shapes-read';
import { rdf, termKey } from './terms';
import { TracedStore, tracer } from './trace';
import { ValidationData } from './validation-data';
import { ValidationRunner } from './validation-runner';
import { readView } from './view-read';
import { views, V } from './views';
import { P } from './vocabulary';
import { newModelGraph } from './model-graph';

/** A patch with more quads than this (a load, a file read) reads the hidden neighbor counts of each view again. */
const NEIGHBOR_PATCH_LIMIT = 2000;

/**
 * The reads of one view for its diagram that do not depend on the geometry of its placements. `changed`: the IRIs of the data
 * statements that changed since `neighbors` was read (a DataPatch, updateHiddenNeighborCounts).
 */
interface ViewReads { figures?: Derivation; neighbors?: Map<string, NeighborCount>; changed?: Set<string>; applicability?: TargetMatch[] }

export interface ModelChange {
    reason: ChangeReason;
    /** The shared patch event that invalidated backend caches. */
    event: GraphChange;
    /** What the change touched (edit, undo, redo). Undefined: anything can have changed. */
    scope?: ChangeScope;
    /** Committed store changes, for incremental display updates. */
    patch?: Patch;
}

/** What a patch touched, as element ids, and its tier (change.ts, §11.3). */
export type { ChangeScope } from './change';

export type Listener = (change: ModelChange) => void;

/**
 * What a validation run changed for the diagrams: the instances and the property shapes whose count of violations changed (a card
 * shows these counts, diagram-schema.ts and notation-schema.ts). A view that shows none of them stays as it is.
 */
export function violationScope(before: Violation[], after: Violation[]): ChangeScope {
    const counts = (vs: Violation[]) => {
        const m = new Map<string, number>();
        for (const v of vs) {
            if (v.severity !== 'Violation') continue;
            for (const id of [v.instance, v.shape]) if (id) m.set(id, (m.get(id) ?? 0) + 1);
        }
        return m;
    };
    const was = counts(before), now = counts(after);
    const elements = [...new Set([...was.keys(), ...now.keys()])].filter(id => was.get(id) !== now.get(id));
    return { tier: tierOf({ reason: 'validation', shapes: false, layout: false }), views: [], elements, shapes: false, layout: false };
}

/** A command refused because it changes protected files (absolute paths). */
function importedFailure(folder: string, files: string[]): CommandResult {
    const names = files.map(f => portableRelative(folder, f));
    const one = names.length === 1;
    return {
        ok: false, imported: files,
        error: `${names.join(', ')} ${one ? 'is a locked file' : 'are locked files'}: the change is not made. To change ${one ? 'it' : 'them'}, unlock ${one ? 'it' : 'them'} in the file navigator.`
    };
}

/** The ok result of an executed command: its id, or its ids. */
function resultOf(r: { ok: true } | { ok: true; value: unknown }): Extract<CommandResult, { ok: true }> {
    const v = 'value' in r ? r.value : undefined;
    if (Array.isArray(v)) return { ok: true, id: v[0], ids: v };
    return { ok: true, id: typeof v === 'string' ? v : undefined };
}

/** Kinds that cannot run in a batch: a move between files and a migration need their own undo step with its files or queue entry. */
const NOT_IN_BATCH = new Set<EditCommand['kind']>(['moveElementsToFile', 'migrateData']);

/**
 * Why a batch is refused before it runs (manifest §5.2), or undefined. A move between files and a migration run alone. A batch with
 * a new view that names its file or folder creates no other view: the settings hold one file and one folder for the new views.
 */
export function batchRefusal(commands: EditCommand[]): string | undefined {
    const alone = commands.findIndex(c => NOT_IN_BATCH.has(c.kind));
    if (alone >= 0) return `Command ${alone}: ${commands[alone].kind} cannot run in a batch. Run it as one exec.`;
    const views = commands.filter(c => c.kind === 'createView' || c.kind === 'duplicateView');
    if (views.length > 1 && views.some(c => c.file || (c.kind === 'createView' && c.folder))) {
        return 'A batch that creates more than one view cannot give a view a file or a folder. Create that view in its own exec.';
    }
    return undefined;
}

const REF = /^\$(\d+)$/;

/**
 * The command with each string "$N" (anywhere in it) replaced by the result id of command N (law_batchRefsResolve). N must be an
 * earlier command with an id.
 */
export function resolveRefs(command: EditCommand, index: number, results: { id?: string }[]): { command: EditCommand } | { error: string } {
    let error: string | undefined;
    const walk = (x: unknown): unknown => {
        if (typeof x === 'string') {
            const m = REF.exec(x);
            if (!m) return x;
            const n = Number(m[1]);
            if (n >= index) { error ??= `${x} refers to command ${n}, which does not come before command ${index}.`; return x; }
            const id = results[n]?.id;
            if (id === undefined) { error ??= `${x} refers to command ${n}, which gives no id.`; return x; }
            return id;
        }
        if (Array.isArray(x)) return x.map(walk);
        if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
        return x;
    };
    const out = walk(command) as EditCommand;
    return error ? { error } : { command: out };
}

/** File operations, one at a time, with a count of the operations queued so far: `ModelStore.dispose` drains the queue. */
class FileQueue extends SerialQueue {
    queued = 0;
    override run<T>(fn: () => Promise<T>): Promise<T> {
        this.queued++;
        return super.run(fn);
    }
}

/** The error of a call of a disposed store (§3.5). */
export const DISPOSED_MESSAGE = 'The model store is disposed: make a new ModelStore.';

/** The warning of a snapshot after a trap of the store and a read of the files (§3.4). */
export const TRAP_RECOVERED = 'The model index failed and was read again from the files. Undo history was cleared.';

export class ModelStore {
    /** Builds the quad store of a graph. A test replaces it with a store that traps. */
    newStore: () => QuadStore = () => new OxigraphStore();
    /** The trap guard of `graph` (rdf-files trap.ts): the one place that detects a WebAssembly trap of the store. */
    protected guard!: TrapGuard;
    protected graph = this.newGraph().graph;
    /** The state after a trap of the store (§3.4). `error`: the read of the files failed too; no further read. Undefined: no trap. */
    protected trapState?: { recovering: boolean; again?: boolean; error?: string };
    protected metamodel: Metamodel = emptyMetamodel();
    warnings: string[] = [];
    /** The open workspace: its files and the dataset. Undefined: none is open. */
    protected settings?: Settings;
    protected loader?: Loader;
    protected saver?: Saver;
    protected readonly history = new History<MigrationChange>();
    protected readonly validationData = (() => {
        const store = this;
        return new ValidationData({
            get graph() { return store.graph; }, get settings() { return store.settings; },
            get metamodel() { return store.metamodel; }, shapesIndex: () => this.shapesIndex()
        }, () => this.validation.invalidate());
    })();
    protected readonly validation = new ValidationRunner(
        () => ({ graph: this.graph, input: () => this.validationData.validationInput(), violations: r => this.validationData.violationsOf(r),
            stamp: () => this.validationData.stamp() }), (before, patch) => this.changed('validation', patch, violationScope(before, this.violations)));
    /** Numeric projections of the shared events for existing snapshot clients. */
    get shapesVersion(): number { return this.graph.keys.shapes.sequence; }
    get revision(): number { return this.graph.change.sequence; }
    protected notified?: GraphChange;
    /** The instance count of the current data event (ModelGraph.keys.data). */
    protected cache: { event?: GraphChange; instances?: number } = {};
    /** The dataset warnings of the snapshot, kept between changes (scoped-doc.ts DatasetWarnings). */
    protected readonly datasetWarnings = new DatasetWarnings();
    /** Old id -> new id, for the view and the instance whose IRI the last change changed. */
    protected movedIds: Record<string, string> = {};
    /** File operations, one at a time: a save and an open cannot overlap. */
    protected readonly fileQueue = new FileQueue();
    /** Set by `dispose` (§3.5). */
    protected disposal?: Promise<void>;
    /** The calls of `syncFromDisk` that have not ended (outside the file queue): `dispose` waits for them. */
    protected readonly diskReads = new Set<Promise<unknown>>();

    protected readonly writer = (() => {
        const store = this;
        return new Writer({
            saver: () => this.saver,
            writable: () => !!this.settings && !this.settings.gone,
            queue: this.fileQueue,
            get warnings() { return store.warnings; },
            set warnings(warnings: string[]) { store.warnings = warnings; },
            saved: () => this.changed('save')
        });
    })();

    protected readonly reconciler = new Reconciler({
        settings: () => this.settings,
        graph: () => this.graph,
        files: () => this.loader!,
        saved: () => this.saver!.savedState(),
        ownWrites: () => this.saver?.ownWrites,
        queue: this.fileQueue,
        syncFromDisk: () => this.syncFromDisk(),
        gone: ws => this.workspaceGone(ws),
        reopen: file => this.reopenFromDisk(file),
        forget: () => this.saver!.forget(),
        filesRead: (read, notes, unmounted, ws) => this.readFromDisk(read, notes, unmounted, ws),
        nothingRead: () => this.nothingReadFromDisk()
    });

    protected readonly listeners = new Set<Listener>();

    /** Call `listener` after each change. */
    onDidChange(listener: Listener): { dispose(): void } {
        this.assertLive();
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    /** A new graph on a new quad store behind a trap guard. The guard becomes `this.guard` when the graph becomes `this.graph`. */
    protected newGraph(): { graph: ModelGraph; guard: TrapGuard } {
        const guard: TrapGuard = new TrapGuard(this.newStore(), trap => this.trapped(trap, guard));
        this.guard ??= guard;
        return { graph: newModelGraph(new TracedStore(guard)), guard };
    }

    /**
     * The store trapped (§3.4 law_trapReadsFilesOnce): the first trap of the current graph starts one read of the files, in the file
     * queue. A trap of another graph (the read after a trap) ends in `recover`. The failing call throws to its caller.
     */
    protected trapped(trap: StoreTrap, guard: TrapGuard): void {
        // A trap during the read after a trap, of the old or the new store (also in the listeners of the load): the read failed.
        if (this.trapState?.recovering) { this.trapState.again = true; return; }
        if (guard !== this.guard || this.trapState || this.disposal) return;
        console.error('[catenary] the model index failed (WebAssembly trap); the files are read again:', trap.cause.stack);
        this.trapState = { recovering: true };
        void this.serial(() => this.recover());
    }

    /** Build a new store and read the workspace again from the files (the source of truth, ADR 0003). A second trap stops with one error. */
    protected async recover(): Promise<void> {
        const ws = this.settings;
        let r: CommandResult;
        try {
            r = ws && !ws.gone ? await this.doOpen(ws.path, ws.workspace.text === undefined) : { ok: false, error: 'no workspace is open' };
        } catch (e) {
            r = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        // A trap during the read (also one that a listener of the load swallowed) is the failure; a file error of the read stays itself.
        if (this.trapState?.again || (r.ok && this.guard.trap)) r = { ok: false, error: 'the model index failed again' };
        if (r.ok) {
            this.trapState = undefined;
            this.warnings = [...this.warnings, TRAP_RECOVERED];
            this.changed('files');
            return;
        }
        const error = `The model index failed and the files cannot be read again (${r.error}). Restart Catenary.`;
        console.error(`[catenary] ${error}`);
        this.trapState = { recovering: false, error };
        this.guard.fail(error);
        this.close();
        // The graph cannot be read: notify the clients without a scope. The snapshot is the trap snapshot.
        for (const l of [...this.listeners]) l({ reason: 'files', event: this.graph.change });
    }

    /** The snapshot while the store is down: no read of the graph. */
    protected trapSnapshot(warning: string): ModelSnapshot {
        return {
            revision: this.revision, file: this.file, files: { files: [], views: [] }, shapesVersion: this.shapesVersion, meta: this.meta,
            counts: { instances: 0, results: 0, violations: 0 }, warnings: [warning], migrations: [], movedIds: {},
            prefixes: { table: { ...PREFIXES }, stored: !!this.settings?.prefixes }, dirty: false, canUndo: false, canRedo: false
        };
    }

    protected cached<K extends 'instances'>(k: K, compute: () => NonNullable<ModelStore['cache'][K]>): NonNullable<ModelStore['cache'][K]> {
        const event = this.graph.keys.data;
        if (this.cache.event !== event) this.cache = { event };
        return (this.cache[k] ??= compute()) as NonNullable<ModelStore['cache'][K]>;
    }

    /** Read host with live state. Shared caches stay keyed by the coordinator's graph events. */
    readonly reads = (() => {
        const store = this;
        return new PanelReads({
            get graph() { return store.graph; }, get metamodel() { return store.metamodel; },
            get settings() { return store.settings; }, get folder() { return store.folder; }, get file() { return store.file; },
            shapesIndex: () => this.shapesIndex(), scoped: scope => this.scoped(scope), viewDoc: view => this.viewDoc(view)
        });
    })();

    /** The shapes index of the shapes graphs and the SKOS vocabulary of the data file (cached per ModelGraph.keys.shapes). */
    protected shapesIndex(): ShapesIndex {
        return shapesIndexOf(this.graph);
    }

    /**
     * The id of an id, an IRI or a triple {s, p, o} (canonicalId, manifest §1.3). The IRI of a property shape gives its p- id.
     * Other values stay the same.
     */
    resolveId(x: string | TripleRef): string {
        const id = canonicalId(x);
        if (typeof x !== 'string' || id === x) return id;
        return this.shapesIndex().byTerm.get(termKey(rdf.namedNode(x))) ?? id;
    }

    /**
     * False for a well-formed id (n-, r-, p-, c-) of a term that the model does not have. True for other values: the reads decide
     * (a figure id, an explorer key).
     */
    knownId(id: string): boolean {
        const idx = this.shapesIndex();
        if (id.startsWith('p-')) return idx.property.has(id);
        if (id.startsWith('c-')) return idx.constraint.has(id);
        const r = relationTriple(id);
        if (r) return this.graph.match(r.s, r.p, r.o).length > 0;
        const t = elementTerm(id);
        if (!t) return true;
        return this.graph.match(t).length > 0 || this.graph.match(null, null, t).length > 0 || this.graph.match(null, null, null, t).length > 0;
    }

    /**
     * The arguments of a read query (MODEL_QUERIES) with each id parameter resolved (resolveId). An error names each value that
     * resolves to an unknown id (knownId). Other parameters stay the same.
     */
    resolveQueryArgs(method: keyof ModelQueries, args: unknown[]): { args: unknown[] } | { error: string } {
        const unknown: unknown[] = [];
        const id = (x: unknown) => {
            if (typeof x !== 'string' && !isTripleRef(x)) return x;
            const resolved = this.resolveId(x);
            if (!this.knownId(resolved)) unknown.push(x);
            return resolved;
        };
        const names = MODEL_QUERIES[method];
        const out = args.map((a, i) => !QUERY_ID_PARAMS.has(names[i]) ? a : Array.isArray(a) ? a.map(id) : id(a));
        return unknown.length ? { error: `No element with the id or IRI ${unknown.map(x => JSON.stringify(x)).join(', ')}.` } : { args: out };
    }

    /**
     * The IRI of an element id or a property shape id; undefined for other ids (a relation has no IRI). A value with ":" is an IRI
     * already (addConcept gives the IRI of the concept).
     */
    iriOf(id: string): string | undefined {
        if (id.includes(':')) return id;
        return idIri(id) ?? this.shapesIndex().model.properties[id]?.uri;
    }

    /** A read model of the elements and views that one request needs (scoped-doc.ts). */
    protected scoped(scope: DocScope): Doc {
        return tracer.span('refresh', 'scoped read', () => {
            tracer.note(`elements ${scope.elements?.length ?? 0}; views ${(scope.views ?? []).filter(Boolean).join(', ') || 'none'}; neighbors ${!!scope.neighbors}; showing ${!!scope.showing}`);
            return this.decorate(scopedDoc({ g: this.graph, shapes: this.shapesIndex().model }, scope));
        });
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

    /**
     * The figures of a view and their join with its placements (ADR 0014). Undefined: no such view. The figures read the store around
     * the placed elements of the view, and a move or a resize keeps them (viewReads): only the join with the placements runs again.
     */
    viewFigures(viewId: string): ViewFigures | undefined {
        const iri = idIri(viewId);
        if (!iri) return undefined;
        return tracer.span('refresh', 'figures', () => {
            // A kept derivation still reads the live store on demand (its data is a LazyTripleIndex, read later by the join and the
            // labels): sound because viewReads drops it at each change of what the figures read (all but layout and the report).
            const reads = this.viewReads(viewId), vf = viewFiguresOf(this.graph, iri, [], reads.figures, true);
            reads.figures = vf.derivation;
            return vf;
        });
    }

    /** For each instance card of the view: the number of related instances in and out that the view does not show (card halo). */
    hiddenNeighborCounts(view: View): Map<string, NeighborCount> {
        const reads = this.viewReads(view.id), shapes = this.shapesIndex().model;
        if (reads.neighbors && reads.changed) {
            const changed = [...reads.changed];
            tracer.note(`changed ${changed.length}`);
            reads.neighbors = updateHiddenNeighborCounts(this.graph, shapes, view, reads.neighbors, changed);
            reads.changed = undefined;
        }
        return reads.neighbors ??= hiddenNeighborCounts(this.graph, shapes, view);
    }

    /**
     * The reads of each view that a move or a resize keeps: they read which elements the view shows, not where. Kept while the store
     * changes only in the geometry of placements and the validation report (ModelGraph.keys.data retains the last event that affects these reads).
     */
    protected viewReadCache: { event?: GraphChange; byView: Map<string, ViewReads>; graph?: ModelGraph; changed?: Set<string>; listener?: { dispose(): void } } = { byView: new Map() };

    /**
     * The kept reads of a view. A change of the data key drops them, but the hidden neighbor counts stay with the IRIs of the changed
     * statements when each change since they were read was a patch of data graphs only (§11.3 DataPatch): no view graph, no shapes.
     */
    protected viewReads(viewId: string): ViewReads {
        const cache = this.viewReadCache, g = this.graph;
        if (cache.graph !== g) {
            cache.graph = g;
            cache.event = undefined;
            cache.listener?.dispose();
            cache.listener = g.onDidChange(e => {
                if (cache.graph !== g || (!e.data && !e.shapes)) return;
                const quads = e.patch.filter(c => c.quad.graph.value !== REPORT_GRAPH);
                if (e.shapes || !quads.length || !cache.changed || quads.length > NEIGHBOR_PATCH_LIMIT || quads.some(c => !g.isDataGraph(c.quad.graph))) { cache.changed = undefined; return; }
                for (const { quad: q } of quads) for (const t of [q.subject, q.object]) if (t.termType === 'NamedNode') cache.changed.add(t.value);
            });
        }
        const event = g.keys.data;
        if (cache.event !== event) {
            const changed = cache.changed, byView = new Map<string, ViewReads>();
            if (changed && cache.event) for (const [id, r] of cache.byView) if (r.neighbors) byView.set(id, { neighbors: r.neighbors, changed: new Set([...r.changed ?? [], ...changed]) });
            Object.assign(cache, { event, byView, changed: new Set<string>() });
        }
        const byView = cache.byView;
        return byView.get(viewId) ?? byView.set(viewId, {}).get(viewId)!;
    }

    /** Derived checked-node connections whose instance and shape cards are both in this view. */
    viewApplicability(view: View): TargetMatch[] {
        return this.viewReads(view.id).applicability ??= this.applicabilityOf(view);
    }

    protected applicabilityOf(view: View): TargetMatch[] { return applicabilityOf(this.graph, view); }

    /**
     * The classification of a patch (change.ts classify, §11.3): its tier, scope, and whether validation runs. In the validation mode
     * "views", the open views count (a placement change on one of them changes what the run checks).
     */
    protected classify(patch: Patch, reason: ChangeReason = 'edit'): Classified {
        const open = this.settings?.validation === 'views' ? this.validationData.openViewIris().map(iri => elementId(rdf.namedNode(iri))) : [];
        return classify(this.graph, patch, reason, open);
    }

    /**
     * The DataPatch tier of a canvas (§11.3 keptDoc, law_keptDocEqualsRead): the records of the changed elements that `part` holds are read
     * again with the scoped read and merged into the part (change.ts mergeRecords). False: the change needs a read of the view
     * (keptAfterRead). A changed element that the view places other than as a card: a node that became an instance, or a mark whose
     * statements a data file holds (a note, a frame, a reference, a collection: its box content is projected, not merged). A held
     * element that is no instance any more (its card goes). A new relation that the view places (its edge shows).
     */
    mergeChanged(part: Doc, viewId: string, elements: string[]): boolean {
        const view = part.views[viewId];
        if (!view) return false;
        const graph = rdf.namedNode(view.uri);
        const held = elements.filter(id => !!part.instances[id]);
        for (const id of elements) {
            const t = elementTerm(id);
            if (t && !cardOf(view, id) && this.graph.match(null, V.element, t, graph).length) return false;
        }
        if (!held.length) return true;
        const fresh = this.scoped({ elements: held, neighbors: true });
        if (held.some(id => !fresh.instances[id])) return false;
        for (const id of mergeRecords(part, viewId, fresh, held)) {
            const r = part.relations[id], triple = rdf.quad(rdf.namedNode(part.instances[r.subject].uri), rdf.namedNode(r.predicate), rdf.namedNode(part.instances[r.object].uri));
            if (this.graph.match(null, P.reifies, triple, graph).length) return false;
        }
        return true;
    }

    /** What the read of a view does not know: the file of each instance, and the path and state of each file reference. */
    protected decorate(doc: Doc): Doc {
        // The file of each instance: the file with most of its statements.
        tracer.span('refresh', 'instance file origins', () => {
            const instances = Object.values(doc.instances);
            tracer.note(`instances ${instances.length}; populated views ${Object.values(doc.views).filter(v => v.boxes.length || v.edges.length || v.arrows.length).map(v => v.id).join(', ') || 'none'}`);
            // One query for all instances (placement.ts filesOfSubjects), not one store read per instance.
            const files = this.settings && instances.length ? filesOfSubjects(this.graph, instances.map(i => i.uri)) : undefined;
            for (const i of instances) {
                const f = files?.get(i.uri)?.[0];
                if (f) i.file = f; else delete i.file;
            }
        });
        // File references: the absolute path (from the folder of the view file), and whether the file is on disk.
        decorateFileReferences(doc, view => this.referenceViewFile(view));
        return doc;
    }

    /** The files that file references name, with their state on disk (for the watcher). */
    protected referencedFiles(): string {
        return referencedFiles(fileReferences(this.graph), view => this.referenceViewFile(view));
    }

    protected referenceViewFile(view: string): string {
        return this.settings?.viewFile(view)?.path ?? path.join(this.folder, 'views', 'x');
    }

    get canUndo(): boolean { return this.history.canUndo; }
    get canRedo(): boolean { return this.history.canRedo; }

    get violations(): Violation[] { return this.validation.violations; }

    /** Validate the model now, without the delay after a change. */
    validate(): Promise<void> { return this.disposal ? Promise.reject(new Error(DISPOSED_MESSAGE)) : this.validation.now(); }

    setOpenView(client: string, viewId: string | undefined): void {
        this.validationData.setOpenView(client, viewId);
    }

    /** The last change (ModelSnapshot.change). */
    protected lastChange?: SnapshotChange;

    snapshot(): ModelSnapshot {
        if (this.trapState) return this.trapSnapshot(this.trapState.error ?? TRAP_MESSAGE);
        return {
            revision: this.revision,
            ...(this.lastChange ? { change: this.lastChange } : {}),
            file: this.file,
            files: tracer.span('snapshot', 'files', () => this.files),
            shapesVersion: this.shapesVersion,
            meta: this.meta,
            counts: {
                instances: this.cached('instances', () => instanceCount(this.graph)),
                results: this.violations.length,
                violations: this.violations.filter(v => v.severity === 'Violation').length,
                ...(this.settings?.validation === 'views' && this.validationData.validated !== undefined ? { validated: this.validationData.validated } : {})
            },
            warnings: [...this.warnings, ...tracer.span('snapshot', 'dataset warnings', () => this.datasetWarnings.read(this.graph, this.shapesIndex().model))],
            migrations: this.history.migrations.map(m => withCount(this.graph, m)),
            movedIds: this.movedIds,
            prefixes: { table: { ...PREFIXES }, stored: !!this.settings?.prefixes },
            dirty: tracer.span('snapshot', 'dirty', () => this.dirty),
            canUndo: this.canUndo,
            canRedo: this.canRedo
        };
    }

    // ------------------------------------------------------------ edits

    /** Run a command as one transaction. On an error, the dataset does not change. */
    execute(command: EditCommand): CommandResult {
        this.assertLive();
        // RPC and CLI pass any JSON value: refuse a value that is not a known command before it is read.
        const shapeError = commandShapeError(command);
        if (shapeError) return { ok: false, error: shapeError };
        return tracer.span('command', command.kind, () => this.executeNow(command));
    }

    /**
     * Run commands as one transaction: one patch, one undo step, one write (manifest §5.2 law_batchOneStep). A command that fails rolls
     * back all of them (law_batchRejectionRollsBack); the result gives its index. A string field "$N" takes the result id of command N
     * (law_batchRefsResolve).
     */
    executeBatch(commands: EditCommand[]): BatchResult {
        this.assertLive();
        if (!Array.isArray(commands)) return { ok: false, error: 'A batch is a JSON array of edit commands.' };
        for (const [index, c] of commands.entries()) {
            const shapeError = commandShapeError(c);
            if (shapeError) return { ok: false, index, error: `Command ${index}: ${shapeError}` };
        }
        const refused = batchRefusal(commands);
        if (refused) return { ok: false, error: refused };
        return tracer.span('command', 'batch', () => this.executeBatchNow(commands));
    }

    protected executeNow(command: EditCommand): CommandResult {
        const ws = this.settings;
        if (!ws) return { ok: false, error: 'No model is open.' };
        const { command: resolved, given } = this.resolveCommand(command);
        const r = this.executeResolved(resolved, ws);
        return r.ok ? this.withIris(r) : this.namingGiven(r, given);
    }

    /** An IRI or a triple {s, p, o} where the command takes an id (manifest §12). `given`: id -> the value that the caller gave. */
    protected resolveCommand(command: EditCommand): { command: EditCommand; given: Map<string, string> } {
        const given = new Map<string, string>();
        command = mapCommandIds(command, x => {
            if (typeof x !== 'string' && !isTripleRef(x)) return x;
            const id = this.resolveId(x);
            if (id !== x) given.set(id, typeof x === 'string' ? x : JSON.stringify(x));
            return id;
        });
        return { command, given };
    }

    /** An error names the value that the caller gave, not the id that it resolved to. */
    protected namingGiven<R extends { ok: false; error: string }>(r: R, given: Map<string, string>): R {
        return given.size ? { ...r, error: [...given].reduce((e, [id, x]) => e.split(id).join(x), r.error) } : r;
    }

    /** An ok result with `iri` next to `id` and `iris` next to `ids`. */
    protected withIris(r: Extract<CommandResult, { ok: true }>): Extract<CommandResult, { ok: true }> {
        const iri = r.id === undefined ? undefined : this.iriOf(r.id);
        return { ...r, ...(iri ? { iri } : {}), ...(r.ids ? { iris: r.ids.map(id => this.iriOf(id) ?? null) } : {}) };
    }

    /**
     * What a command needs before its transaction: the path of a file reference relative to its view file, the folder or the file of a
     * new view, the known files of a move. Sets `newViewFolder` and `newViewFile` of the settings.
     */
    protected prepare(command: EditCommand, ws: Settings): { command: EditCommand } | { failure: Extract<CommandResult, { ok: false }> } {
        const failure = (error: string) => ({ failure: { ok: false as const, error } });
        if (command.kind === 'addFileReference') {
            // The file reference keeps the path relative to its view file (the folder can move).
            const f = ws.viewFile(elementTerm(command.view)?.value ?? '');
            if (!f) return { failure: gone('view', command.view) as Extract<CommandResult, { ok: false }> };
            command = { ...command, file: portableRelative(path.dirname(f.path), path.resolve(this.folder, command.file)) };
        }
        if (command.kind === 'createView' && command.folder) {
            const folder = path.resolve(this.folder, command.folder);
            if (folder !== this.folder && !isInside(this.folder, folder)) return failure(`The folder ${command.folder} is not in the workspace folder.`);
            ws.newViewFolder = folder;
        }
        if (command.kind === 'createView' && command.folder && ws.isImported(path.join(ws.newViewFolder!, 'view.view.trig'))) {
            ws.newViewFolder = undefined;
            return failure(`The folder ${command.folder} is for imported files.`);
        }
        if ((command.kind === 'createView' || command.kind === 'duplicateView') && command.file) {
            const file = path.resolve(this.folder, command.file);
            const problem = ws.newViewFileProblem(file) ?? (ws.isImported(file) ? `${command.file} is a locked file.` : undefined);
            if (problem) { ws.newViewFolder = undefined; return failure(problem); }
            ws.newViewFile = file;
        }
        if (command.kind === 'moveElementsToFile') {
            command = { ...command, source: ws.knownFile(path.resolve(this.folder, command.source)) ?? command.source,
                destination: ws.knownFile(path.resolve(this.folder, command.destination)) ?? command.destination };
            const imported = [command.source, command.destination].filter(f => ws.isImported(f));
            if (imported.length) return { failure: importedFailure(this.folder, imported) as Extract<CommandResult, { ok: false }> };
            const problem = ws.transferProblem([command.source, command.destination]);
            if (problem) return failure(problem);
        }
        return { command };
    }

    protected executeResolved(command: EditCommand, ws: Settings): CommandResult {
        const prepared = this.prepare(command, ws);
        if ('failure' in prepared) return prepared.failure;
        command = prepared.command;
        const shapesBefore = this.shapesIndex(), revision = this.graph.keys.shapes;
        // Imported files (manifest ws:imported): a command that changes their statements fails as a whole (no partial change).
        const { result: r, patch } = this.graph.transact((g): ReturnType<typeof executeCommand> | CommandResult => {
            const r = command.kind === 'moveElementsToFile'
                ? transfer(g, ws, command.source, command.destination, command.ids)
                : executeCommand(g, this.metamodel, command);
            if (r.ok) placeChanges(g, ws);
            const files = r.ok ? ws.importedChanges(g.changes()) : [];
            return files.length ? importedFailure(this.folder, files) : r;
        });
        if (!r.ok) { ws.newViewFolder = ws.newViewFile = undefined; return r; }
        this.commitEdit(patch, [command.kind], shapesBefore, revision, command.kind === 'migrateData' ? command.migration.id : undefined,
            command.kind === 'moveElementsToFile' ? [command.source, command.destination] : []);
        return resultOf(r);
    }

    /** After a committed edit transaction: the commit notes, the file tracking, the undo step and the change event. */
    protected commitEdit(patch: Patch, kinds: string[], shapesBefore: ShapesIndex, revision: unknown, migration?: string, transferFiles: string[] = []): void {
        const ws = this.settings!;
        if (patch.length) {
            this.writer.commitNotes.push(...kinds);
            this.track(patch);
        }
        this.history.record(patch, migration, this.graph.proposed, transferFiles);
        this.graph.proposed = [];
        if (patch.length) {
            this.contentChanged(patch, this.graph.keys.shapes !== revision ? shapesBefore : undefined);
            this.changed('edit', patch);
        }
        ws.newViewFolder = ws.newViewFile = undefined;
    }

    protected executeBatchNow(commands: EditCommand[]): BatchResult {
        const ws = this.settings;
        if (!ws) return { ok: false, error: 'No model is open.' };
        const shapesBefore = this.shapesIndex(), revision = this.graph.keys.shapes;
        const results: Extract<CommandResult, { ok: true }>[] = [];
        // The views that this batch creates: a file reference to one of them has no view file yet.
        const created = new Set<string>();
        let failedAt: number | undefined, rebuilt = false;
        const { result, patch } = this.graph.transact((g): CommandResult => {
            for (const [index, item] of commands.entries()) {
                failedAt = index;
                const referred = resolveRefs(item, index, results);
                if ('error' in referred) return { ok: false, error: referred.error };
                const { command, given } = this.resolveCommand(referred.command);
                if (command.kind === 'addFileReference' && created.has(command.view)) {
                    return { ok: false, error: 'A file reference cannot go to a view that the same batch creates. Add it in a second exec.' };
                }
                const prepared = this.prepare(command, ws);
                if ('failure' in prepared) return this.namingGiven(prepared.failure, given);
                const shapes = g.keys.shapes, start = g.changes().length;
                const r = executeCommand(g, this.metamodel, prepared.command);
                if (!r.ok) return this.namingGiven(r, given);
                // A view keeps its file only when the patch removes one view and adds one (movedIds), at the edit, the undo and the redo.
                const views = viewsChanged(g, g.changes().slice(start));
                if (commands.length > 1 && views.gone.length === 1 && views.added.length === 1) {
                    return { ok: false, error: 'This command changes the IRI of a view. Run a view IRI change as a single exec.' };
                }
                // The next command reads the metamodel of the shapes so far (a relation that a new shape permits).
                if (g.keys.shapes !== shapes) { this.rebuildMetamodel(); rebuilt = true; }
                const one = resultOf(r);
                if ((command.kind === 'createView' || command.kind === 'duplicateView') && one.id) created.add(one.id);
                results.push(one);
            }
            failedAt = undefined;
            placeChanges(g, ws);
            const files = ws.importedChanges(g.changes());
            return files.length ? importedFailure(this.folder, files) : { ok: true };
        });
        if (!result.ok) {
            ws.newViewFolder = ws.newViewFile = undefined;
            // The metamodel of the shapes before the batch.
            if (rebuilt) this.rebuildMetamodel();
            const kind = failedAt === undefined ? undefined : commands[failedAt].kind;
            return failedAt === undefined ? result : { ...result, index: failedAt, error: `Command ${failedAt} (${kind}): ${result.error}` };
        }
        this.commitEdit(patch, commands.map(c => c.kind), shapesBefore, revision);
        return { ok: true, results: results.map(r => this.withIris(r)) };
    }

    undo(): CommandResult { this.assertLive(); return tracer.span('command', 'undo', () => this.replay('undo')); }
    redo(): CommandResult { this.assertLive(); return tracer.span('command', 'redo', () => this.replay('redo')); }

    /**
     * Apply the last patch of the undo (backwards) or redo stack. The patch queue goes back to its state of that step. A step that
     * changes a file that is imported now is refused, as an edit is (the step stays on its stack).
     */
    protected replay(reason: 'undo' | 'redo'): CommandResult {
        const next = this.history.peek(reason);
        if (!next || !this.settings) return { ok: true };
        const applied: Patch = reason === 'undo' ? [...next.patch].reverse().map(c => ({ op: c.op === 'add' ? 'remove' : 'add', quad: c.quad })) : next.patch;
        const files = [...new Set([...this.settings.importedChanges(applied), ...next.transferFiles.filter(f => this.settings!.isImported(f))])];
        if (files.length) return importedFailure(this.folder, files);
        const problem = this.settings.transferProblem(next.transferFiles);
        if (problem) return { ok: false, error: problem };
        const step = this.history.take(reason)!;
        const shapesBefore = this.shapesIndex(), revision = this.graph.keys.shapes;
        this.graph[reason](step.patch);
        this.track(applied);
        this.contentChanged(applied, this.graph.keys.shapes !== revision ? shapesBefore : undefined);
        this.changed(reason, this.graph.change.patch);
        return { ok: true };
    }

    /** Remove an entry of the patch queue without applying it. Not an undo step. */
    dismissMigration(id: string): void {
        this.assertLive();
        if (this.history.dismiss(id)) this.changed('queue');
    }

    /** Keep the files of the statements in step with a patch (settings.ts). */
    protected track(patch: Patch): void {
        this.settings?.track(patch);
    }

    /**
     * The dataset changed. Validation runs by the rule of §9 validates (change.ts): a layout change does not start it.
     * `patch`: the changes in the order applied. `shapesBefore`: the shapes index before them, when they changed the shapes or the
     * vocabulary (ModelGraph.keys.shapes); no patch: anything can have changed.
     */
    protected contentChanged(patch?: Patch, shapesBefore?: ShapesIndex): void {
        const shapes = !patch || !!shapesBefore;
        if (shapes) this.rebuildMetamodel();
        this.movedIds = patch ? movedIds(this.graph, patch, shapesBefore ? { before: shapesBefore, after: this.shapesIndex() } : undefined) : {};
        // A view graph whose IRI changed stays in its view file. (Other moved ids, such as property shapes, are not graphs.)
        for (const [from, to] of Object.entries(this.movedIds)) this.settings?.moveViewFile(elementTerm(from)?.value ?? '', elementTerm(to)?.value ?? '');
        this.settings?.assignViewFiles();
        if (!patch || this.classify(patch).validates) this.validation.invalidate();
    }

    /** `scope`: what a change without a patch touched (a validation run); else the scope of `patch`; neither: anything. */
    protected changed(reason: ChangeReason, patch?: Patch, scope?: ChangeScope): void {
        if (reason !== 'edit' && reason !== 'undo' && reason !== 'redo') this.movedIds = {};
        if (reason !== 'save' && this.notified === this.graph.change) this.graph.invalidate({});
        const event = this.graph.change;
        this.notified = event;
        if (!patch && (reason === 'load' || reason === 'files')) patch = event.patch.length ? event.patch : undefined;
        scope ??= patch && this.classify(patch, reason);
        this.lastChange = { reason, ...scope };
        // A ViewPatch, a save or a report cannot change the file references: the state of the last content change stays (keepsReads).
        if (this.settings && reason !== 'disk' && reason !== 'validation' && !keepsReads(this.lastChange)) this.referencedState = this.referencedFiles();
        const wasm = this.wasmMemory();
        if (tracer.on) {
            tracer.span('change', reason, () => {
                tracer.note(`${this.listeners.size} listeners${scope ? `; tier ${scope.tier}; views ${scope.views.length}, elements ${scope.elements.length}${scope.shapes ? ', shapes' : ''}${scope.layout ? ', layout only' : ''}` : ''}${wasm ? `; wasm ${wasm} MB` : ''}`);
                for (const l of [...this.listeners]) l({ reason, event, scope, patch });
            });
        } else for (const l of [...this.listeners]) l({ reason, event, scope, patch });
        // Disk is the source of truth (ADR 0003): every change is written at once.
        if (reason === 'undo' || reason === 'redo' || reason === 'files') this.writer.commitNotes.push(reason);
        if (reason === 'edit' || reason === 'undo' || reason === 'redo' || reason === 'files') this.writer.queueWrite();
        if (reason === 'load' || reason === 'files' || reason === 'shapes') this.watch();
    }

    /** The largest WebAssembly memory of the store that the backend log reported (MB). */
    protected wasmLogged = 0;

    /**
     * The WebAssembly memory of the Oxigraph store in MB (spec/open.md STORE3): the trace notes it at each change. The backend log gets
     * a line each time it passes a new multiple of 256 MB (it never shrinks).
     */
    protected wasmMemory(): number | undefined {
        const bytes = oxigraphMemoryBytes();
        if (bytes === undefined) return undefined;
        const mb = Math.round(bytes / 1048576);
        if (Math.floor(mb / 256) > Math.floor(this.wasmLogged / 256)) {
            this.wasmLogged = mb;
            console.log(`[catenary] the model index uses ${mb} MB of WebAssembly memory (${this.graph.store.size} quads)`);
        }
        return mb;
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
    /**
     * Watch the folder of the workspace file and its subfolders. An event starts `syncFromDisk` after 150 ms without events (an editor
     * writes a file in more than one step). Hidden files and folders (.git) and Catenary's own temporary files are ignored; its own writes
     * change nothing (the text on disk is the text it wrote).
     */
    protected watch(): void {
        if (this.disposal) return;
        if (!this.settings || !this.watching || this.settings.gone) return this.close();
        this.reconciler.watch(this.folder);
    }

    /** Stop watching the files. The store stays usable; a later open or read of the files watches again. */
    close(): void {
        this.reconciler.close();
    }

    /**
     * Stop the store (§3.5 law_disposedStoreSilent): stop the watcher and the validation, wait for the file operations that are queued
     * and the running `syncFromDisk` calls (also the writes that they queue), and remove the listeners. No change event and no report after the promise resolves. A later
     * call that changes the store throws DISPOSED_MESSAGE. The shared validation worker stays: other stores can use it
     * (stopValidationWorker). Each call gives the same promise.
     */
    dispose(): Promise<void> {
        return this.disposal ??= (async () => {
            this.close();
            await this.validation.dispose();
            for (let queued = -1; queued !== this.fileQueue.queued || this.diskReads.size;) {
                queued = this.fileQueue.queued;
                await Promise.allSettled([...this.diskReads]);
                await this.fileQueue.idle();
            }
            this.listeners.clear();
            this.viewReadCache.listener?.dispose();
            this.viewReadCache = { byView: new Map() };
        })();
    }

    /** The store is disposed (§3.5). */
    get disposed(): boolean {
        return !!this.disposal;
    }

    protected assertLive(): void {
        if (this.disposal) throw new Error(DISPOSED_MESSAGE);
    }

    /**
     * Read again the files that another program changed (the text on disk is not the text that Catenary last read or wrote), and the
     * files that are new or removed in the folder. A changed workspace file opens the workspace again. The disk wins over a write that
     * is pending. No undo across it. Returns the names of the files read.
     */
    syncFromDisk(): Promise<string[]> {
        if (this.disposal) return Promise.reject(new Error(DISPOSED_MESSAGE));
        const read = this.reconciler.syncFromDisk();
        const ended = () => { this.diskReads.delete(read); };
        this.diskReads.add(read);
        read.then(ended, ended);
        return read;
    }

    protected workspaceGone(ws: Settings): void {
        // Keep the model as it is, stop watching, say it once.
        const note = `${path.basename(ws.path)} was removed or moved on disk: the files are not read or written until the workspace is opened again.`;
        this.close();
        ws.gone = true;
        if (!this.warnings.includes(note)) {
            this.warnings = [...this.warnings, note];
            this.changed('files');
        }
    }

    protected async reopenFromDisk(file: string): Promise<void> {
        const name = path.basename(file);
        const r = await this.doOpen(file);
        this.warnings = [...this.warnings, r.ok ? `${name} changed on disk: the workspace was opened again.` : `${name} changed on disk and cannot be opened: ${r.error}`];
        this.changed('files');
    }

    protected nothingReadFromDisk(): void {
        // Only a referenced file appeared or disappeared: new doc, no write.
        if (this.referencedFiles() !== this.referencedState) {
            this.graph.invalidate({ data: true });
            this.referencedState = this.referencedFiles();
            this.changed('disk');
        }
    }

    protected async readFromDisk(read: string[], notes: string[], unmounted: Set<string>, ws: Settings): Promise<void> {
        // The failed write of a file that was read again is not pending any more; a new failure shows again.
        const notRead = (w: string) => [...unmounted].some(n => w.startsWith(`${n}: not read: `));
        this.warnings = [...this.warnings.filter(w => w !== this.writer.writeError && !notRead(w) && !/ changed on disk: read again| was removed on disk| is new on disk/.test(w)), ...notes];
        this.writer.writeError = undefined;
        await this.saver!.recordUncommitted(read.map(f => path.resolve(this.folder, f)));
        ws.syncShapesTarget();
        this.filesChanged('files');
    }

    // ------------------------------------------------------------ files

    /** Run file operations one at a time, so that a save and an open cannot overlap. */
    protected serial<T>(fn: () => Promise<T>): Promise<T> {
        if (this.disposal) return Promise.reject(new Error(DISPOSED_MESSAGE));
        return this.fileQueue.run(fn);
    }

    /** Path of the primary workspace file. */
    get file(): string | undefined {
        return this.settings?.path;
    }

    /** The folder of the workspace file: the model files are in it and its subfolders. */
    get folder(): string {
        return this.settings?.folder ?? '';
    }

    get files(): WorkspaceFiles {
        return this.settings ? { ...this.settings.info(views(this.graph).map(v => elementId(v)), this.saver!.savedState()), repo: this.saver!.repo } : { files: [], views: [] };
    }

    /** The file for new subjects when "near" finds no file (settings.ts). */
    get defaultFile(): string | undefined {
        return this.settings?.defaultFile;
    }

    get dirty(): boolean {
        return this.saver?.dirty ?? false;
    }

    /**
     * Open a workspace file, or a folder (`resolveOpenTarget`). A folder without a workspace file opens with the default settings; its
     * `workspace.trig` is written at the first change of a setting. That path while it is not on disk (a recent entry) is its folder.
     */
    open(workspacePath: string): Promise<CommandResult> {
        return this.serial(async () => {
            const target = await resolveOpenTarget(workspacePath);
            if ('error' in target) return { ok: false, error: target.error };
            return this.doOpen(target.file, target.ofFolder);
        });
    }

    /** `ofFolder`: the folder was given; a workspace file that is not on disk is the default manifest. */
    protected async doOpen(primaryPath: string, ofFolder = false): Promise<CommandResult> {
        const { graph, guard } = this.newGraph();
        const r = await openWorkspace(graph, primaryPath, ofFolder);
        if ('error' in r) return { ok: false, error: r.error };
        if (this.settings) this.settings.retired = true;
        this.settings = r.settings;
        this.loader = r.loader;
        this.saver = new Saver(graph, r.settings, text => this.note(text));
        this.graph = graph;
        this.guard = guard;
        // An open after a failed recovery is a recovery: the new store answers. The recovery itself clears its state when it ends.
        if (this.trapState && !this.trapState.recovering) this.trapState = undefined;
        this.history.clear();
        this.validation.reset();
        this.contentChanged();
        this.warnings = r.warnings;
        await this.saver.recordUncommitted();
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

    /**
     * The metamodel: the palette classes, links and fields of the plugins (SHACL on the shapes graphs, RDFS on all files), with the SKOS
     * vocabulary of the shapes graphs and of the model graph. `dataset`: the shapes and the vocabulary, for the form (validation reads the shapes graphs, validationInput).
     */
    protected rebuildMetamodel(): void {
        const shapes = shapesTriples(this.graph);
        // The vocabulary (concept schemes, concepts) is part of the metamodel: the targets of scheme properties.
        const vocabulary = vocabularyQuads(this.graph).map(q => rdf.quad(q.subject, q.predicate, q.object));
        const sources = this.settings?.shapeSources() ?? [];
        const dataset = rdf.dataset([...shapes, ...vocabulary]);
        this.metamodel = { ...authoringMetamodel(this.graph, buildVocabulary(dataset, this.graph.language)), source: sources.join(', ') || undefined, dataset };
    }

    /** Replace the prefix table. It goes to the manifest of the primary workspace file (saved with it). No undo step. */
    setPrefixes(prefixes: Record<string, string>): Promise<CommandResult> {
        return this.serial(async () => {
            if (!this.settings) return { ok: false, error: 'No model is open.' };
            const problem = prefixesProblem(prefixes);
            if (problem) return { ok: false, error: problem };
            this.settings.prefixes = { ...prefixes };
            setPrefixes(this.settings.prefixes);
            this.graph.invalidate();
            // Compact IRIs in the read models: labels, paths, "Not mapped" rows.
            this.rebuildMetamodel();
            this.changed('files');
            return { ok: true };
        });
    }

    /**
     * Change the settings of the manifest (ADR 0004): the default file and the file of each kind (a model file, or a new RDF file in
     * the workspace folder; a kind: also "near"), the exclude globs. Written at once. A new exclude glob reads the files again. No undo step.
     */
    setSettings(settings: { defaultFile?: string; placement?: Partial<Placement>; exclude?: string[]; imported?: string[]; validation?: ValidationMode; language?: string; autoCommit?: boolean }): Promise<CommandResult> {
        return this.serial(() => this.applySettings(settings));
    }

    protected async applySettings(settings: { defaultFile?: string; placement?: Partial<Placement>; exclude?: string[]; imported?: string[]; validation?: ValidationMode; language?: string; autoCommit?: boolean }): Promise<CommandResult> {
        const ws = this.settings;
        if (!ws) return { ok: false, error: 'No workspace is open.' };
        // A file to mark as imported must be on disk as Catenary has it: the write gives blank nodes their IRIs in the file.
        if (settings.imported?.some(g => !ws.importedGlobs.includes(g)) && this.saver!.dirty) {
            this.writer.commitNotes.push('before import mark');
            await this.writer.write();
        }
        const validation = ws.validation;
        const r = ws.applySettings(settings, this.saver!.savedState());
        if ('error' in r) return { ok: false, error: r.error };
        if (ws.validation !== validation) this.validation.invalidate(0);
        if (r.reread) {
            await this.writer.write();
            return this.doOpen(ws.path);
        }
        ws.syncShapesTarget();
        this.changed('files');
        return { ok: true };
    }

    /**
     * Mark one file as imported or as own (a path relative to the workspace folder, or absolute): add its path to the imported globs,
     * or remove the globs that are its path. A file that another glob still matches stays imported (error that names the glob).
     */
    setImported(file: string, on: boolean): Promise<CommandResult> {
        return this.serial(async () => {
            const ws = this.settings;
            if (!ws) return { ok: false, error: 'No workspace is open.' };
            const abs = path.resolve(this.folder, file);
            if (!isInside(this.folder, abs)) return { ok: false, error: `${file}: the file must be in the folder of the workspace file.` };
            const rel = portableRelative(this.folder, abs);
            const globs = ws.importedGlobs;
            if (on) return ws.isImported(abs) ? { ok: true } : this.applySettings({ imported: [...globs, rel] });
            const r = await this.applySettings({ imported: globs.filter(g => g !== rel) });
            if (!r.ok) return r;
            const glob = ws.importedGlobs.find(g => ws.isImported(abs, [g]));
            return glob ? { ok: false, error: `${rel} stays locked by the glob "${glob}". Remove the glob in the Workspace settings.` } : r;
        });
    }

    /**
     * Import RDF files (§2.6). A model file or view file of the workspace is marked as imported where it is (no copy). Another file gets
     * a Turtle copy with IRIs for its blank nodes in imported/<name>.ttl (-2, … when taken), marked as imported. The prefixes of the
     * files that the workspace table does not have are added; a prefix whose name or namespace the table has with another value is not
     * (a note). All files or none. With copies, the workspace is read again once: no undo across it.
     */
    importFiles(sources: string[]): Promise<ImportResult> {
        return this.serial(() => importFiles(sources, {
            settings: () => this.settings, readSources: readImportSources,
            copies: (folder, reads) => new ImportCopies(folder, reads),
            dirty: () => this.saver!.dirty, savedState: () => this.saver!.savedState(),
            commitNote: note => this.writer.commitNotes.push(note), write: () => this.writer.write(),
            written: files => this.saver!.written.push(...files), reopen: file => this.doOpen(file),
            prefixesChanged: () => { this.graph.invalidate(); this.rebuildMetamodel(); },
            note: text => this.note(text), changed: () => this.changed('files')
        }));
    }

    /** Write the files that are not written yet (after a failed write), and commit them. Normally there is nothing to write. */
    save(): Promise<CommandResult> {
        return this.serial(() => this.writer.write());
    }

    protected note(text: string): void {
        if (!this.warnings.includes(text)) this.warnings.push(text);
        this.notes.push(text);
        console.warn(`[catenary] ${text}`);
    }

    /** Notes of the writes, for the tests and the log. */
    readonly notes: string[] = [];

}
