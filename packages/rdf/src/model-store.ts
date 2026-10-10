import { TargetMatch } from '@catenary/shacl/common';
import type { ExplorerScope } from './explorer';
import { PanelReads } from './panel-reads';
import { applicabilityOf } from './queries';
import { filesOfElement } from './selection';
// The model store: one RDF dataset (ModelGraph), shared by all diagram sessions and by the frontend. It coordinates the parts:
// the files on disk and the dataset read from them (settings.ts, loader.ts, reconciler.ts, placement.ts, saver.ts), undo and the patch queue (history.ts), validation
// (validation-runner.ts), and the read models of the panels and editors, built for each request (ADR 0012: no shared Doc).
// All edits go through `execute` (one EditCommand = one transaction = one patch = one undo step). File operations run one at a time.
// Each change is written at once (ADR 0003). A shape edit that changes what the data must say adds a migration to the patch queue.

import {
    ChangeReason, CommandResult, Derivation, Doc, EditCommand, ImportResult, MetamodelInfo, ModelSnapshot, PREFIXES, SnapshotChange,
    ValidationMode, View, ViewFigures, Violation, WorkspaceFiles, idIri, prefixesProblem, setPrefixes
} from '@catenary/model';
import type { NamedNode } from '@rdfjs/types';
import * as path from 'path';
import { OxigraphStore, SerialQueue, isInside, portableRelative } from 'rdf-files';
import { Placements } from './actions';
import { authoringMetamodel } from './authoring';
import { executeCommand } from './commands';
import { Placement, decorateFileReferences, referencedFiles } from './files';
import { GraphChange, ModelGraph, Patch, VALIDATION_GRAPH, isRdfsQuad, isVocabularyQuad } from './graph';
import { History } from './history';
import { elementId, elementTerm } from './ids';
import { importFiles } from './import';
import { Loader, openWorkspace, readImportSources, resolveOpenTarget } from './loader';
import { movedIds } from './moved-ids';
import { LAYOUT_PREDICATES, viewFiguresOf } from './notations';
import { gone } from './ops';
import { filesOfSubject, placeChanges, transfer } from './placement';
import { Reconciler } from './reconciler';
import { ImportCopies, Saver, Writer } from './saver';
import { DocScope, fileReferences, hiddenNeighborCounts, instanceCount, readWarnings, scopedDoc } from './scoped-doc';
import { Settings, createWorkspace } from './settings';
import { withCount } from './shape-ops';
import { Metamodel, buildVocabulary, emptyMetamodel } from './shapes';
import { ShapesIndex, shapesIndexOf } from './shapes-read';
import { rdf } from './terms';
import { TracedStore, tracer } from './trace';
import { ValidationData } from './validation-data';
import { ValidationRunner } from './validation-runner';
import { readView } from './view-read';

export type { ChangeReason };

/** The reads of one view for its diagram that do not depend on the geometry of its placements. */
interface ViewReads { figures?: Derivation; neighbors?: Map<string, { in: number; out: number; targets?: number }>; applicability?: TargetMatch[] }

export interface ModelChange {
    reason: ChangeReason;
    /** The shared patch event that invalidated backend caches. */
    event: GraphChange;
    /** What the change touched (edit, undo, redo). Undefined: anything can have changed. */
    scope?: ChangeScope;
    /** Committed store changes, for incremental display updates. */
    patch?: Patch;
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
    return { views: [], elements, shapes: false, layout: false };
}

/** A command refused because it changes protected files (absolute paths). */
function importedFailure(folder: string, files: string[]): CommandResult {
    const names = files.map(f => portableRelative(folder, f));
    const one = names.length === 1;
    return {
        ok: false, imported: files,
        error: `${names.join(', ')} ${one ? 'is an imported file' : 'are imported files'}: the change is not made. To change ${one ? 'it' : 'them'}, mark ${one ? 'it' : 'them'} as own in the file navigator.`
    };
}

export class ModelStore {
    protected graph = new ModelGraph(new TracedStore(new OxigraphStore()));
    protected metamodel: Metamodel = emptyMetamodel();
    warnings: string[] = [];
    /** The open workspace: its files and the dataset. Undefined: none is open. */
    protected settings?: Settings;
    protected loader?: Loader;
    protected saver?: Saver;
    protected readonly history = new History();
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
    /** Reads that placement geometry and reports cannot change. */
    protected cache: { event?: GraphChange; placements?: Placements; instances?: number; explorer?: Map<string, ExplorerScope>; readWarnings?: string[] } = {};
    /** Old id -> new id, for the view and the instance whose IRI the last change changed. */
    protected movedIds: Record<string, string> = {};
    /** File operations, one at a time: a save and an open cannot overlap. */
    protected readonly fileQueue = new SerialQueue();

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
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    protected cached<K extends 'placements' | 'instances' | 'explorer' | 'readWarnings'>(k: K, compute: () => NonNullable<ModelStore['cache'][K]>): NonNullable<ModelStore['cache'][K]> {
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
            shapesIndex: () => this.shapesIndex(), scoped: scope => this.scoped(scope), viewDoc: view => this.viewDoc(view),
            explorerScopes: () => this.cached('explorer', () => new Map())
        });
    })();

    /** The shapes index of the shapes graphs and the SKOS vocabulary of the data file (cached per ModelGraph.keys.shapes). */
    protected shapesIndex(): ShapesIndex {
        return shapesIndexOf(this.graph);
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
            const reads = this.viewReads(viewId), vf = viewFiguresOf(this.graph, iri, [], reads.figures);
            reads.figures = vf.derivation;
            return vf;
        });
    }

    /** For each instance card of the view: the number of related instances in and out that the view does not show (card halo). */
    hiddenNeighborCounts(view: View): Map<string, { in: number; out: number; targets?: number }> {
        const reads = this.viewReads(view.id);
        return reads.neighbors ??= hiddenNeighborCounts(this.graph, this.shapesIndex().model, view);
    }

    /**
     * The reads of each view that a move or a resize keeps: they read which elements the view shows, not where. Kept while the store
     * changes only in the geometry of placements and the validation report (ModelGraph.keys.data retains the last event that affects these reads).
     */
    protected viewReadCache: { event?: GraphChange; byView: Map<string, ViewReads> } = { byView: new Map() };

    protected viewReads(viewId: string): ViewReads {
        const event = this.graph.keys.data;
        if (this.viewReadCache.event !== event) this.viewReadCache = { event, byView: new Map() };
        const byView = this.viewReadCache.byView;
        return byView.get(viewId) ?? byView.set(viewId, {}).get(viewId)!;
    }

    /** Derived checked-node connections whose instance and shape cards are both in this view. */
    viewApplicability(view: View): TargetMatch[] {
        return this.viewReads(view.id).applicability ??= this.applicabilityOf(view);
    }

    protected applicabilityOf(view: View): TargetMatch[] { return applicabilityOf(this.graph, view); }

    /**
     * The files with statements of an element (Open in → Source, spec 0.4): the triples with the element as subject; a relation: its
     * triple; no such triples: the triples with it as object. Most statements first.
     */
    filesOfElement(id: string): string[] {
        return filesOfElement(this.graph, () => this.shapesIndex(), this.settings, id);
    }

    protected scopeOf(patch: Patch): ChangeScope {
        const views = new Set<string>(), elements = new Set<string>();
        let shapes = this.graph.change.shapes, layout = true;
        for (const { quad: q } of patch) {
            if (q.graph.value === VALIDATION_GRAPH) { layout = false; continue; }
            if (this.graph.isShapesGraph(q.graph)) {
                shapes = true;
                layout = false;
                continue;
            }
            if (!this.graph.isDataGraph(q.graph)) {
                if (q.graph.termType === 'NamedNode') views.add(elementId(q.graph));
                if (!LAYOUT_PREDICATES.has(q.predicate.value)) layout = false;
                continue;
            }
            layout = false;
            // A concept scheme, concept or collection of the data file: the value set cards and the metamodel change too. An RDFS rule
            // statement changes the metamodel.
            if (isVocabularyQuad(q) || isRdfsQuad(q)) shapes = true;
            for (const t of [q.subject, q.object]) if (t.termType === 'NamedNode') elements.add(elementId(t as NamedNode));
        }
        return { views: [...views], elements: [...elements], shapes, layout: layout && patch.length > 0 };
    }

    /** What the read of a view does not know: the file of each instance, and the path and state of each file reference. */
    protected decorate(doc: Doc): Doc {
        // The file of each instance: the file with most of its statements.
        tracer.span('refresh', 'instance file origins', () => {
            const instances = Object.values(doc.instances);
            tracer.note(`instances ${instances.length}; populated views ${Object.values(doc.views).filter(v => v.boxes.length || v.edges.length || v.arrows.length).map(v => v.id).join(', ') || 'none'}`);
            for (const i of instances) {
                const f = this.settings && filesOfSubject(this.graph, rdf.namedNode(i.uri))[0];
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
    validate(): Promise<void> { return this.validation.now(); }

    setOpenView(client: string, viewId: string | undefined): void {
        this.validationData.setOpenView(client, viewId);
    }

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
                violations: this.violations.filter(v => v.severity === 'Violation').length,
                ...(this.settings?.validation === 'views' && this.validationData.validated !== undefined ? { validated: this.validationData.validated } : {})
            },
            warnings: [...this.warnings, ...this.cached('readWarnings', () => readWarnings(this.graph, this.shapesIndex().model))],
            migrations: this.history.migrations.map(m => withCount(this.graph, m)),
            movedIds: this.movedIds,
            prefixes: { table: { ...PREFIXES }, stored: !!this.settings?.prefixes },
            dirty: this.dirty,
            canUndo: this.canUndo,
            canRedo: this.canRedo
        };
    }

    // ------------------------------------------------------------ edits

    /** Run a command as one transaction. On an error, the dataset does not change. */
    execute(command: EditCommand): CommandResult {
        return tracer.span('command', command.kind, () => this.executeNow(command));
    }

    protected executeNow(command: EditCommand): CommandResult {
        const ws = this.settings;
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
        if ((command.kind === 'createView' || command.kind === 'duplicateView') && command.file) {
            const file = path.resolve(this.folder, command.file);
            const problem = ws.newViewFileProblem(file) ?? (ws.isImported(file) ? `${command.file} is an imported file.` : undefined);
            if (problem) { ws.newViewFolder = undefined; return { ok: false, error: problem }; }
            ws.newViewFile = file;
        }
        if (command.kind === 'moveElementsToFile') {
            command = { ...command, source: ws.knownFile(path.resolve(this.folder, command.source)) ?? command.source,
                destination: ws.knownFile(path.resolve(this.folder, command.destination)) ?? command.destination };
            const imported = [command.source, command.destination].filter(f => ws.isImported(f));
            if (imported.length) return importedFailure(this.folder, imported);
            const problem = ws.transferProblem([command.source, command.destination]);
            if (problem) return { ok: false, error: problem };
        }
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
        if (patch.length) {
            this.writer.commitNotes.push(command.kind);
            this.track(patch);
        }
        this.history.record(patch, command.kind === 'migrateData' ? command.migration.id : undefined, this.graph.proposed,
            command.kind === 'moveElementsToFile' ? [command.source, command.destination] : []);
        this.graph.proposed = [];
        if (patch.length) {
            this.contentChanged(patch, this.graph.keys.shapes !== revision ? shapesBefore : undefined);
            this.changed('edit', patch);
        }
        ws.newViewFolder = ws.newViewFile = undefined;
        const v = 'value' in r ? r.value : undefined;
        if (Array.isArray(v)) return { ok: true, id: v[0], ids: v };
        return { ok: true, id: typeof v === 'string' ? v : undefined };
    }


    undo(): CommandResult { return tracer.span('command', 'undo', () => this.replay('undo')); }
    redo(): CommandResult { return tracer.span('command', 'redo', () => this.replay('redo')); }

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
        if (this.history.dismiss(id)) this.changed('queue');
    }

    /** Keep the files of the statements in step with a patch (settings.ts). */
    protected track(patch: Patch): void {
        this.settings?.track(patch);
    }

    /**
     * The dataset changed. Validation depends on the model graph only: a layout change does not start it.
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
        if (shapes || patch.some(c => this.graph.isDataGraph(c.quad.graph))) this.validation.invalidate();
        // The validation mode "views": a placement on an open view changes what validation checks.
        else if (this.settings?.validation === 'views') {
            const open = new Set(this.validationData.openViewIris());
            if (patch.some(c => open.has(c.quad.graph.value) && !LAYOUT_PREDICATES.has(c.quad.predicate.value))) this.validation.invalidate();
        }
    }

    /** `scope`: what a change without a patch touched (a validation run); else the scope of `patch`; neither: anything. */
    protected changed(reason: ChangeReason, patch?: Patch, scope?: ChangeScope): void {
        if (reason !== 'edit' && reason !== 'undo' && reason !== 'redo') this.movedIds = {};
        if (reason !== 'save' && this.notified === this.graph.change) this.graph.invalidate({});
        const event = this.graph.change;
        this.notified = event;
        if (!patch && (reason === 'load' || reason === 'files')) patch = event.patch.length ? event.patch : undefined;
        scope ??= patch && this.scopeOf(patch);
        if (this.settings && reason !== 'disk') this.referencedState = this.referencedFiles();
        this.lastChange = { reason, ...scope };
        if (tracer.on) {
            tracer.span('change', reason, () => {
                tracer.note(`${this.listeners.size} listeners${scope ? `; views ${scope.views.length}, elements ${scope.elements.length}${scope.shapes ? ', shapes' : ''}${scope.layout ? ', layout only' : ''}` : ''}`);
                for (const l of [...this.listeners]) l({ reason, event, scope, patch });
            });
        } else for (const l of [...this.listeners]) l({ reason, event, scope, patch });
        // Disk is the source of truth (ADR 0003): every change is written at once.
        if (reason === 'undo' || reason === 'redo' || reason === 'files') this.writer.commitNotes.push(reason);
        if (reason === 'edit' || reason === 'undo' || reason === 'redo' || reason === 'files') this.writer.queueWrite();
        if (reason === 'load' || reason === 'files' || reason === 'shapes') this.watch();
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
        if (!this.settings || !this.watching || this.settings.gone) return this.close();
        this.reconciler.watch(this.folder);
    }

    /** Stop watching the files. */
    close(): void {
        this.reconciler.close();
    }

    /**
     * Read again the files that another program changed (the text on disk is not the text that Catenary last read or wrote), and the
     * files that are new or removed in the folder. A changed workspace file opens the workspace again. The disk wins over a write that
     * is pending. No undo across it. Returns the names of the files read.
     */
    syncFromDisk(): Promise<string[]> {
        return this.reconciler.syncFromDisk();
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
        return this.settings ? this.settings.info(this.graph.views().map(v => elementId(v)), this.saver!.savedState()) : { files: [], views: [] };
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
        const graph = new ModelGraph(new TracedStore(new OxigraphStore()));
        const r = await openWorkspace(graph, primaryPath, ofFolder);
        if ('error' in r) return { ok: false, error: r.error };
        if (this.settings) this.settings.retired = true;
        this.settings = r.settings;
        this.loader = r.loader;
        this.saver = new Saver(graph, r.settings, text => this.note(text));
        this.graph = graph;
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
        const shapes = this.graph.shapesTriples();
        // The vocabulary (concept schemes, concepts) is part of the metamodel: the targets of scheme properties.
        const vocabulary = this.graph.vocabularyQuads().map(q => rdf.quad(q.subject, q.predicate, q.object));
        const sources = this.settings?.shapeSources() ?? [];
        const dataset = rdf.dataset([...shapes, ...vocabulary]);
        this.metamodel = { ...authoringMetamodel(this.graph, buildVocabulary(dataset)), source: sources.join(', ') || undefined, dataset };
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
    setSettings(settings: { defaultFile?: string; placement?: Partial<Placement>; exclude?: string[]; imported?: string[]; validation?: ValidationMode }): Promise<CommandResult> {
        return this.serial(() => this.applySettings(settings));
    }

    protected async applySettings(settings: { defaultFile?: string; placement?: Partial<Placement>; exclude?: string[]; imported?: string[]; validation?: ValidationMode }): Promise<CommandResult> {
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
