// One GLSP client session shows one view. The session reads the part of the model that its view shows
// (ModelStore.viewDoc: SPARQL rows of the view graph and the model, view-read.ts) and re-sends its graph when a change touches that part.

import {
    Action, ActionDispatcher, ClientId, ClientSessionManager, CommandStack, GModelFactory, GModelRoot, GModelSerializer, MessageAction, ModelState,
    ModelSubmissionHandler, RequestModelAction, SaveModelAction, SetDirtyStateAction, SourceModelStorage
} from '@eclipse-glsp/server';
import { Command } from '@eclipse-glsp/server';
import { inject, injectable } from '@theia/core/shared/inversify';
import { viewIdOfUri } from '../../common/protocol';
import { CommandResult, Doc, EditCommand, emptyDoc, hiddenShapeSources, placementOfId, toSchema } from '@catenary/model';
import { ChangeScope, ModelStore } from '@catenary/rdf';

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

    get view() {
        return this.part.views[this.viewId];
    }

    /** Read the part of the model that this view shows. */
    load(): void {
        this.part = this.store.viewDoc(this.viewId);
    }

    /** A change with this scope can change what the view shows. A shapes change: shape cards, and class names on instance cards. */
    affectedBy(scope?: ChangeScope): boolean {
        return !scope || scope.shapes || scope.views.some(id => !!this.part.views[id]) || scope.elements.some(id => !!this.part.instances[id]);
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
        if (this.started) return;
        this.started = true;
        const listener = this.store.onDidChange(e => {
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
                this.sessions.removeListener(sessionListener);
            }
        };
        this.sessions.addListener(sessionListener, this.clientId);
    }

    /** Send the current graph and dirty state to the client. */
    async refresh(): Promise<void> {
        try {
            const actions = await this.submission.submitModel('operation');
            await this.dispatcher.dispatchAll(actions);
        } catch (e) {
            console.error('[catenary] refresh failed', e);
        }
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
        this.session.load();
        const schemes = new Map((store.meta.schemes ?? []).map(x => [x.iri, x.label]));
        const { part } = this.session, view = part.views[this.session.viewId];
        const neighbors = view ? store.hiddenNeighborCounts(view) : new Map<string, { in: number; out: number }>();
        const schema = toSchema(this.session.part, store.meta, this.session.viewId, {
            showHidden: this.session.showHidden, cardScale: this.session.cardScale, violations: store.violations, schemeLabel: iri => schemes.get(iri) ?? iri.replace(/^.*[#/:]/, ''),
            hidden: { neighbors: id => neighbors.get(id), shapeSources: id => hiddenShapeSources(part.shapes, view, id).length },
            notation: store.viewFigures(this.session.viewId)
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
