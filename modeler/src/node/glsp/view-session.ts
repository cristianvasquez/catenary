// One GLSP client session shows one view. The session reads the part of the model that its view shows
// (ModelStore.viewDoc: SPARQL rows of the view graph and the model, view-read.ts) and re-sends its graph when a change touches that part.

import {
    Action, ActionDispatcher, ClientId, ClientSessionManager, CommandStack, GModelFactory, GEdge, GModelRoot, GModelSerializer, MessageAction, ModelState,
    ModelSubmissionHandler, RequestModelAction, SaveModelAction, SetDirtyStateAction, SourceModelStorage
} from '@eclipse-glsp/server';
import { Command } from '@eclipse-glsp/server';
import { inject, injectable } from '@theia/core/shared/inversify';
import { viewIdOfUri } from '../../common/protocol';
import { CommandResult, Doc, EditCommand, NS, TYPES, edgeLanes, iriId, emptyDoc, hiddenShapeSources, placementOfId, toSchema } from '@catenary/model';
import { ChangeScope, ModelChange, ModelStore, tracer } from '@catenary/rdf';

const placementId = iriId;

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

    accept(change: ModelChange): void {
        const patch = change.patch, view = this.view;
        const edges = new Set(view?.edges.filter(e => {
            const r = this.part.relations[e.relation];
            return e.id && r && !view.boxes.some(b => b.kind === 'collection' && [r.subject, r.object].some(id => b.members.includes(id)));
        }).map(e => e.id!) ?? []);
        const removed = new Set(patch?.filter(c => c.op === 'remove' && c.quad.predicate.value === NS.rdf + 'reifies').map(c => placementId(c.quad.subject.value)));
        // Hubs, lines, arrows, boxes and additions use the full projection and its cascade rules.
        if (this.showHidden || !view || !patch?.length || patch.some(c => c.op !== 'remove'
            || c.quad.graph.value !== view.uri || !edges.has(placementId(c.quad.subject.value)) || !removed.has(placementId(c.quad.subject.value)))) {
            this.removedEdges = undefined;
            return;
        }
        this.removedEdges ??= new Set();
        for (const c of patch) this.removedEdges.add(placementId(c.quad.subject.value));
        view.edges = view.edges.map(e => e.id && this.removedEdges!.has(e.id) ? { relation: e.relation, hidden: true } : e);
    }

    get view() {
        return this.part.views[this.viewId];
    }

    /** Read the part of the model that this view shows. */
    load(): void {
        this.removedEdges = undefined;
        this.part = tracer.span('refresh', 'read view', () => this.store.viewDoc(this.viewId));
    }

    /**
     * A change with this scope can change what the view shows. A shapes change: shape cards, and class names on instance cards. An
     * element: an instance, or a property shape of a shape card (a validation run changes its count of violations).
     */
    affectedBy(scope?: ChangeScope): boolean {
        return !scope || scope.shapes || scope.views.some(id => !!this.part.views[id])
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
            if (this.state.affectedBy(e.scope)) this.state.accept(e);
            if (this.muted) return;
            if (e.reason === 'save') {
                this.dispatcher.dispatch(SetDirtyStateAction.create(false, { reason: 'save' }));
            } else if (this.state.affectedBy(e.scope)) {
                this.refresh();
            }
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
        this.session.load();
        const schemes = new Map((store.meta.schemes ?? []).map(x => [x.iri, x.label]));
        const { part } = this.session, view = part.views[this.session.viewId];
        const neighbors = view ? store.hiddenNeighborCounts(view) : new Map<string, { in: number; out: number }>();
        const schema = toSchema(this.session.part, store.meta, this.session.viewId, {
            showHidden: this.session.showHidden, cardScale: this.session.cardScale, violations: store.violations, schemeLabel: iri => schemes.get(iri) ?? iri.replace(/^.*[#/:]/, ''),
            hidden: { neighbors: id => neighbors.get(id), shapeSources: id => hiddenShapeSources(part.shapes, view, id).length },
            notation: store.viewFigures(this.session.viewId), applicability: view ? store.viewApplicability(view) : []
        });
        const root = this.serializer.createRoot(schema as never) as GModelRoot;
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
