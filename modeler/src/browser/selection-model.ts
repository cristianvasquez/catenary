// The selected elements: one state for the window. Each view (view editors, Model Explorer, Outline, Links, Properties,
// Appearance) writes it on a user gesture and shows it on each change. No view selects in another view.
// The selection holds ids only. The backend resolves it (RPC `selected`): its elements by kind, and the ids that still exist.

import { Emitter } from '@theia/core';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ModelSelection, ModelSnapshot, Selected, emptySelected, panelsUnchanged } from '@catenary/model';
import { ModelFrontend } from './model-client';

export type { ModelSelection, Selected } from '@catenary/model';

@injectable()
export class SelectionModel {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;

    protected current: ModelSelection = { ids: [] };
    /** Changes only when a snapshot can change selection facts. */
    protected resolutionEpoch = 0;
    protected readonly onDidChangeEmitter = new Emitter<ModelSelection>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    /** The last answer of the backend for the selection: `selection` and `revision` that it is for. */
    protected answer: { selection: ModelSelection; revision: number; epoch: number; value: Selected } = { selection: this.current, revision: -1, epoch: -1, value: emptySelected() };
    protected readonly onDidResolveEmitter = new Emitter<Selected>();
    /** Fires when the backend resolved the current selection (after a change of the selection or of the model). */
    readonly onDidResolve = this.onDidResolveEmitter.event;

    @postConstruct()
    protected init(): void {
        this.model.onDidChange(s => void this.follow(s));
    }

    get selection(): ModelSelection {
        return this.current;
    }

    set(s: ModelSelection): void {
        const ids = [...new Set(s.ids)];
        if (s.view === this.current.view && sameIds(ids, this.current.ids)) return;
        this.current = { view: s.view, ids };
        this.onDidChangeEmitter.fire(this.current);
        void this.resolve();
    }

    /**
     * The current selection by kind, as the backend last resolved it. It can be one answer behind the selection: an action that runs
     * on it uses `resolve()`.
     */
    get resolved(): Selected {
        return this.answer.value;
    }

    /** The current selection by kind, for the current model revision. */
    resolve(): Promise<Selected> {
        const selection = this.current, revision = this.model.snapshot.revision, epoch = this.resolutionEpoch;
        if (this.answer.selection === selection && this.answer.revision === revision && this.answer.epoch === epoch) return Promise.resolve(this.answer.value);
        return this.model.service.selected(selection).then(value => {
            if (this.current !== selection || this.resolutionEpoch !== epoch) return this.resolve();
            this.answer = { selection, revision: this.model.snapshot.revision, epoch, value };
            this.onDidResolveEmitter.fire(value);
            return value;
        });
    }

    /** After a model change: ids whose IRI changed follow; ids of deleted elements go. */
    protected async follow({ movedIds, change, revision }: ModelSnapshot): Promise<void> {
        if (this.model.isOpen && panelsUnchanged(change) && !Object.keys(movedIds).length) {
            if (this.answer.selection === this.current && this.answer.epoch === this.resolutionEpoch) this.answer.revision = revision;
            return;
        }
        const epoch = ++this.resolutionEpoch;
        const moved = (id: string) => movedIds[id] ?? id;
        const before = this.current;
        const next = { view: before.view && moved(before.view), ids: before.ids.map(moved) };
        if (!this.model.isOpen) return this.set({ ids: [] });
        const r = await this.model.service.selected(next);
        // Another gesture changed the selection meanwhile: it wins.
        if (this.current !== before || epoch !== this.resolutionEpoch) return;
        const sameView = r.view === before.view;
        if (sameView && sameIds(r.ids, before.ids)) {
            this.answer = { selection: before, revision: this.model.snapshot.revision, epoch, value: r };
            this.onDidResolveEmitter.fire(r);
            return;
        }
        this.set({ view: r.view, ids: r.ids });
    }
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every(id => set.has(id));
}
