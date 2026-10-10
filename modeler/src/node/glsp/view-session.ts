// One GLSP client session shows one view. The session reads the part of the model that its view shows
// (ModelStore.viewDoc: SPARQL rows of the view graph and the model, view-read.ts) and re-sends its graph when a change touches that part.

import {
    Action, ActionDispatcher, ClientId, ClientSessionManager, CommandStack, GModelFactory, GEdge, GModelRoot, GModelSerializer, MessageAction, ModelState,
    ModelSubmissionHandler, RequestModelAction, SaveModelAction, SetDirtyStateAction, SourceModelStorage
} from '@eclipse-glsp/server';
import { Command } from '@eclipse-glsp/server';
import { inject, injectable } from '@theia/core/shared/inversify';
import { viewIdOfUri } from '../../common/protocol';
import {
    CommandResult, DEFAULT_COLLECTION_SIZE, DEFAULT_NOTE_SIZE, DEFAULT_SIZE, DEFAULT_VIEW_REFERENCE_SIZE, Doc, EditCommand, GROUP_SIZE, NS, SIDES, Side, TYPES, View,
    ViewBox, edgeLanes, iriId, emptyDoc, hiddenShapeSources, placementOfId, toSchema
} from '@catenary/model';
import { ChangeScope, ModelChange, ModelStore, tracer } from '@catenary/rdf';

const placementId = iriId;
type Patch = NonNullable<ModelChange['patch']>;

/** The size of a box without width or height in the file (records.ts projectView). */
const BOX_SIZES: Record<ViewBox['kind'], { width: number; height: number }> = {
    card: DEFAULT_SIZE, group: GROUP_SIZE, note: DEFAULT_NOTE_SIZE, reference: DEFAULT_VIEW_REFERENCE_SIZE, collection: DEFAULT_COLLECTION_SIZE
};

/** Session state: the view shown and the "show hidden edges" toggle. No dependencies on GLSP services (avoids DI cycles). */
@injectable()
export class ViewState {
    @inject(ModelStore) readonly store: ModelStore;
    viewId = '';
    showHidden = false;
    /** Card text scale of the client (`catenarySetCardScale`): minimum heights of cards with rows. */
    cardScale = 1;
    /** Read model of this view: the view, its instances and the relations between them. */
    part: Doc = emptyDoc();

    /** Edge IDs removed from the displayed graph by a committed placement-only patch. */
    removedEdges?: Set<string>;

    /** The next model build reads the view again (`load`). False: the kept part is current and the schema is built from it. */
    readDue = true;

    /**
     * Keep `part` in step with a change (law_layoutChangeReadsNoView). A validation run: the schema reads the new counts from the
     * store. A layout-only patch of this view: its values go to the boxes and edges of the kept part. A removal of placed instance
     * edges: the edges leave the kept part (law_edgeRemovalUpdatesDisplay). Any other change: the next build reads the view again.
     */
    accept(change: ModelChange): void {
        const { reason, scope, patch } = change, view = this.view;
        if (reason === 'validation') return;
        if (!view || !scope || !patch?.length || !(reason === 'edit' || reason === 'undo' || reason === 'redo')) { this.invalidate(); return; }
        if (scope.layout) {
            if (!tracer.span('refresh', 'layout patch', () => this.applyLayout(patch, view))) this.invalidate();
            // A pending edge removal is already in the part (hidden edges): the next build from the part shows both changes.
            else this.removedEdges = undefined;
            return;
        }
        if (!this.acceptRemovedEdges(patch, view)) this.invalidate();
    }

    protected invalidate(): void {
        this.readDue = true;
        this.removedEdges = undefined;
    }

    /** Put the geometry and style values of a layout-only patch of `view` on its boxes, edges and arrows. False: a placement is not in the part. */
    protected applyLayout(patch: Patch, view: View): boolean {
        // The last added value of each placement property wins; a removal without an addition restores the default.
        const values = new Map<string, { id: string; prop: string; value?: string; removed: boolean }>();
        for (const { op, quad: q } of patch) {
            if (q.graph.value !== view.uri || !q.predicate.value.startsWith(NS.view)) continue;
            const id = placementId(q.subject.value), prop = q.predicate.value.slice(NS.view.length), k = `${id} ${prop}`;
            const e = values.get(k) ?? values.set(k, { id, prop, removed: false }).get(k)!;
            if (op === 'add') e.value = q.object.value; else e.removed = true;
        }
        const number = (v: string | undefined, fallback: number) => v === undefined || isNaN(Number(v)) ? fallback : Number(v);
        for (const { id, prop, value } of values.values()) {
            const box = view.boxes.find(b => b.id === id);
            if (box) {
                if (prop === 'x' || prop === 'y') box[prop] = number(value, 0);
                else if (prop === 'width' || prop === 'height') box[prop] = number(value, BOX_SIZES[box.kind][prop]);
                else if (prop === 'color') { if (value) box.color = value; else delete box.color; }
                else if (prop === 'display' && box.kind === 'card') { if (value === 'simple') box.display = 'simple'; else delete box.display; }
                continue;
            }
            const edge = view.edges.find(e => e.id === id);
            if (edge) {
                if (prop === 'fromSide' || prop === 'toSide') { if (value && SIDES.includes(value as Side)) edge[prop] = value as Side; else delete edge[prop]; }
                else if (prop === 'color') { if (value) edge.color = value; else delete edge.color; }
                continue;
            }
            const arrow = view.arrows.find(a => a.id === id);
            if (arrow) {
                if (prop === 'color') { if (value) arrow.color = value; else delete arrow.color; }
                continue;
            }
            // A placement that the part does not hold as a box (a list figure, a property pill): read again.
            return false;
        }
        return true;
    }

    /** A removal of placed instance edges only: the edges become hidden in the kept part. False: any other patch. */
    protected acceptRemovedEdges(patch: Patch, view: View): boolean {
        const edges = new Set(view.edges.filter(e => {
            const r = this.part.relations[e.relation];
            return e.id && r && !view.boxes.some(b => b.kind === 'collection' && [r.subject, r.object].some(id => b.members.includes(id)));
        }).map(e => e.id!));
        const removed = new Set(patch.filter(c => c.op === 'remove' && c.quad.predicate.value === NS.rdf + 'reifies').map(c => placementId(c.quad.subject.value)));
        // Hubs, lines, arrows, boxes and additions use the full projection and its cascade rules.
        if (this.showHidden || patch.some(c => c.op !== 'remove'
            || c.quad.graph.value !== view.uri || !edges.has(placementId(c.quad.subject.value)) || !removed.has(placementId(c.quad.subject.value)))) return false;
        this.removedEdges ??= new Set();
        for (const c of patch) this.removedEdges.add(placementId(c.quad.subject.value));
        view.edges = view.edges.map(e => e.id && this.removedEdges!.has(e.id) ? { relation: e.relation, hidden: true } : e);
        return true;
    }

    get view() {
        return this.part.views[this.viewId];
    }

    /** Read the part of the model that this view shows. */
    load(): void {
        this.removedEdges = undefined;
        this.readDue = false;
        this.part = tracer.span('refresh', 'read view', () => this.store.viewDoc(this.viewId));
    }

    /**
     * A change with this scope can change what the view shows. A shapes change: shape cards, and class names on instance cards. An
     * element: an instance, or a property shape of a shape card (a validation run changes its count of violations). A layout-only
     * change: only the sessions of the changed views (law_layoutChangeStaysInView).
     */
    affectedBy(scope?: ChangeScope): boolean {
        if (!scope) return true;
        if (scope.layout) return scope.views.includes(this.viewId);
        return scope.shapes || scope.views.some(id => !!this.part.views[id])
            || scope.elements.some(id => !!this.part.instances[id] || !!this.part.shapes.properties[id]);
    }
}

/** Sends updates to the client. One per session. */
@injectable()
export class ViewSession {
    @inject(ViewState) readonly state: ViewState;
    @inject(ModelSubmissionHandler) protected readonly submission: ModelSubmissionHandler;
    @inject(ActionDispatcher) protected readonly dispatcher: ActionDispatcher;
    @inject(ClientSessionManager) protected readonly sessions: ClientSessionManager;
    @inject(ClientId) protected readonly clientId: string;

    protected muted = false;
    protected started = false;
    /** The canvas of the client is shown (`catenarySetVisible`). Hidden: changes wait for the next show (law_hiddenCanvasRefreshesOnce). */
    protected visible = true;
    /** A change arrived while the canvas was hidden. */
    protected refreshDue = false;

    get store(): ModelStore { return this.state.store; }
    get viewId(): string { return this.state.viewId; }
    get view() { return this.state.view; }
    get part(): Doc { return this.state.part; }

    start(viewId: string): void {
        this.state.viewId = viewId;
        // The validation mode "views" checks the elements on the open views.
        this.store.setOpenView(this.clientId, viewId);
        if (this.started) return;
        this.started = true;
        const listener = this.store.onDidChange(e => {
            if (e.reason === 'save') {
                if (!this.muted) this.dispatcher.dispatch(SetDirtyStateAction.create(false, { reason: 'save' }));
                return;
            }
            if (!this.state.affectedBy(e.scope)) return;
            this.state.accept(e);
            if (this.muted) return;
            if (this.visible) this.refresh(); else this.refreshDue = true;
        });
        const sessionListener = {
            sessionDisposed: () => {
                listener.dispose();
                this.store.setOpenView(this.clientId, undefined);
                this.sessions.removeListener(sessionListener);
            }
        };
        this.sessions.addListener(sessionListener, this.clientId);
    }

    /** The client shows or hides the canvas. A show after changes sends one update. */
    setVisible(visible: boolean): Promise<void> {
        this.visible = visible;
        if (!visible || !this.refreshDue) return Promise.resolve();
        this.refreshDue = false;
        return this.refresh();
    }

    /** Send the current graph and dirty state to the client. */
    refresh(): Promise<void> {
        return tracer.span('refresh', `view ${this.view?.label ?? this.viewId}`, async () => {
            // Yield so display work starts after the edit has returned to the RPC caller.
            await new Promise<void>(resolve => setImmediate(resolve));
            try {
                const actions = await this.submission.submitModel('operation');
                await this.dispatcher.dispatchAll(actions);
            } catch (e) {
                console.error('[catenary] refresh failed', e);
            }
        });
    }

    /**
     * Run an edit for this session. The session sends its own update first, then `followUp`
     * (for example a selection of the created element). Errors go to the client as a message.
     */
    async edit(command: EditCommand, followUp?: (r: CommandResult & { ok: true }) => Action[]): Promise<void> {
        this.muted = true;
        let r: CommandResult;
        try {
            r = this.store.execute(command);
        } finally {
            this.muted = false;
        }
        if (!r.ok) {
            await this.dispatcher.dispatchAll([MessageAction.create(r.error, { severity: 'WARNING' }), ...await this.submission.submitModel('operation')]);
            return;
        }
        const actions = await this.submission.submitModel('operation');
        this.refreshDue = false;
        // The diagram identifies a card or an edge by its placement: the created elements by their placement in this view.
        const shown = (id: string) => placementOfId(this.view, id);
        const result = { ...r, ...(r.id ? { id: shown(r.id) } : {}), ...(r.ids ? { ids: r.ids.map(shown) } : {}) };
        await this.dispatcher.dispatchAll([...actions, ...(followUp?.(result) ?? [])]);
    }

    message(text: string, severity: 'INFO' | 'WARNING' | 'ERROR' = 'WARNING'): Promise<void> {
        return this.dispatcher.dispatch(MessageAction.create(text, { severity }));
    }
}

/** Reads the view id from the source URI (catenary-view:/<view id>) and starts the session. */
@injectable()
export class ViewModelStorage implements SourceModelStorage {
    @inject(ViewSession) protected readonly session: ViewSession;

    loadSourceModel(action: RequestModelAction): void {
        const uri = String(action.options?.uri ?? action.options?.sourceUri ?? '');
        const viewId = viewIdOfUri(uri);
        if (!viewId) throw new Error(`Not a view URI: ${uri}`);
        this.session.start(viewId);
    }

    async saveSourceModel(_action: SaveModelAction): Promise<void> {
        const r = await this.session.store.save();
        if (!r.ok) throw new Error(r.error);
    }
}

@injectable()
export class ViewGModelFactory implements GModelFactory {
    @inject(ViewState) protected readonly session: ViewState;
    @inject(ModelState) protected readonly modelState: ModelState;
    @inject(GModelSerializer) protected readonly serializer: GModelSerializer;

    createModel(): void {
        const { store } = this.session;
        if (this.session.removedEdges) {
            const removed = this.session.removedEdges;
            this.session.removedEdges = undefined;
            const root = this.modelState.root;
            if ([...removed].every(id => root.children.some(e => e.id === id && e.type === TYPES.RELATION))) {
                root.children = root.children.filter(e => !removed.has(e.id));
                const edges = root.children.filter(e => e.type === TYPES.RELATION || e.type === TYPES.BUNDLE) as GEdge[];
                const lane = edgeLanes(edges.map(e => [e.sourceId, e.targetId]));
                for (const edge of edges) Object.assign(edge, lane(edge.sourceId, edge.targetId));
                this.modelState.updateRoot(root);
                return;
            }
        }
        if (this.session.readDue) this.session.load();
        const schemes = new Map((store.meta.schemes ?? []).map(x => [x.iri, x.label]));
        const { part } = this.session, view = part.views[this.session.viewId];
        const neighbors = tracer.span('refresh', 'hidden neighbors', () => view ? store.hiddenNeighborCounts(view) : new Map<string, { in: number; out: number }>());
        const notation = store.viewFigures(this.session.viewId);
        const applicability = tracer.span('refresh', 'applicability', () => view ? store.viewApplicability(view) : []);
        const schema = tracer.span('refresh', 'schema', () => toSchema(this.session.part, store.meta, this.session.viewId, {
            showHidden: this.session.showHidden, cardScale: this.session.cardScale, violations: store.violations, schemeLabel: iri => schemes.get(iri) ?? iri.replace(/^.*[#/:]/, ''),
            hidden: { neighbors: id => neighbors.get(id), shapeSources: id => hiddenShapeSources(part.shapes, view, id).length },
            notation, applicability
        }));
        const root = tracer.span('refresh', 'graph model', () => this.serializer.createRoot(schema as never) as GModelRoot);
        this.modelState.updateRoot(root);
    }
}

/**
 * Undo, redo and dirty state belong to the shared store, not to the session:
 * one undo stack for all views, the tree and the properties panel.
 */
@injectable()
export class StoreCommandStack implements CommandStack {
    @inject(ModelStore) protected readonly store: ModelStore;

    async execute(command: Command): Promise<void> { await command.execute(); }
    undo(): void { this.store.undo(); }
    canUndo(): boolean { return this.store.canUndo; }
    redo(): void { this.store.redo(); }
    canRedo(): boolean { return this.store.canRedo; }
    saveIsDone(): void { /* the store tracks the saved content */ }
    get isDirty(): boolean { return this.store.dirty; }
    flush(): void { /* shared stack: nothing to flush per session */ }
}
