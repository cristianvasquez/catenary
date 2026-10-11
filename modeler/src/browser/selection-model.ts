// The selected elements: one state for the window (spec/ui-manifest.hs §3.3 law_oneSelectionPerWindow). Each view (view editors,
// Model Explorer, Outline, Links, Properties, Appearance) writes it on a user gesture and shows it on each change. No view selects in
// another view: the canvas of the origin view selects, other canvases highlight (diagram/selection-sync.ts).
// The selection holds ids only. The backend resolves it (RPC `selected`): its elements by kind, and the ids that still exist.

import { Emitter } from '@theia/core';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ModelSelection, ModelSnapshot, Selected, emptySelected, panelsUnchanged } from '@catenary/model';
import { ModelFrontend } from './model-client';

export type { ModelSelection, Selected } from '@catenary/model';

/** The quiet time after a change of the selection before its read (spec/ui-manifest.hs §4.2 selectionQuietMs). */
export const SELECTION_QUIET_MS = 100;

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
    /** The read on the way for a selection, revision and epoch: a second ask for the same joins it. */
    protected inFlight?: { selection: ModelSelection; revision: number; epoch: number; promise: Promise<Selected> };
    /** The quiet time after a change of the selection (law_selectionReadsLastOnly): its read goes when the timer fires. */
    protected quiet?: { timer: ReturnType<typeof setTimeout>; done: Promise<Selected>; resolve: (value: Promise<Selected>) => void };

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
        // The quiet read is scheduled before the listeners run: a listener that follows the selection joins it (whenResolved).
        void this.schedule();
        this.onDidChangeEmitter.fire(this.current);
    }

    /**
     * The facts of the current selection as a panel that follows it needs them: the scheduled quiet read when one is pending, else
     * the answer or a read at once. A listener of onDidChange uses this, not `resolve()`, so a marquee sends one read.
     */
    whenResolved(): Promise<Selected> {
        return this.quiet?.done ?? this.resolve();
    }

    /**
     * Resolve after the quiet time: a marquee or a shift-click sequence sends one read, of the last selection. A change within the
     * quiet time restarts it. The promise answers for the selection that is current when the timer fires.
     */
    protected schedule(): Promise<Selected> {
        if (!this.quiet) {
            let resolve!: (value: Promise<Selected>) => void;
            const done = new Promise<Selected>(r => { resolve = r; });
            this.quiet = { timer: undefined as unknown as ReturnType<typeof setTimeout>, done, resolve };
        }
        const quiet = this.quiet;
        clearTimeout(quiet.timer);
        quiet.timer = setTimeout(() => {
            this.quiet = undefined;
            quiet.resolve(this.resolve());
        }, SELECTION_QUIET_MS);
        return quiet.done;
    }

    /**
     * The current selection by kind, as the backend last resolved it. It can be one answer behind the selection: an action that runs
     * on it uses `resolve()`.
     */
    get resolved(): Selected {
        return this.answer.value;
    }

    /** The current selection by kind, for the current model revision. An action asks at once; it joins a read on the way. */
    resolve(): Promise<Selected> {
        const selection = this.current, revision = this.model.snapshot.revision, epoch = this.resolutionEpoch;
        if (this.answer.selection === selection && this.answer.revision === revision && this.answer.epoch === epoch) return Promise.resolve(this.answer.value);
        const flying = this.inFlight;
        if (flying && flying.selection === selection && flying.revision === revision && flying.epoch === epoch) return flying.promise;
        const landed = () => { if (this.inFlight?.promise === promise) this.inFlight = undefined; };
        const promise: Promise<Selected> = this.model.service.selected(selection).then(value => {
            landed();
            // The selection or the model changed meanwhile: the answer of the current selection, after its quiet time when one runs.
            if (this.current !== selection || this.resolutionEpoch !== epoch) return this.quiet?.done ?? this.resolve();
            this.answer = { selection, revision: this.model.snapshot.revision, epoch, value };
            this.onDidResolveEmitter.fire(value);
            return value;
        }, (e: unknown) => {
            // A failed read is not kept: the next resolve() asks again. The callers of this one get the error.
            landed();
            throw e;
        });
        this.inFlight = { selection, revision, epoch, promise };
        return promise;
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
