// The actions of a selection (spec/ui-manifest.hs §4, packages/model/src/actions.ts): the backend decides which actions apply
// (RPC `selectionActions`); this service keeps the last answer for the window selection and for explicit targets (a Links row, a
// class folder), so that menus and keys can ask synchronously. Menus show nothing for a target whose answer has not arrived yet.

import { Emitter } from '@theia/core';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ActionState, ActionTarget, ItemFacts, SelectionActions, targetKey, panelsUnchanged } from '@catenary/model';
import { ViewEditors } from './diagram/view-editors';
import { ModelFrontend } from './model-client';
import { SelectionModel } from './selection-model';

const EMPTY: SelectionActions = { actions: [], items: [], cards: [] };

/** An explicit target as a command argument (a Links row, a class folder): `{ ids, view? }`. */
export function isActionTarget(arg: unknown): arg is ActionTarget {
    return !!arg && typeof arg === 'object' && Array.isArray((arg as ActionTarget).ids) && !('node' in (arg as object));
}

/** Actions that act on the view itself when nothing is selected on its canvas (spec/ui-manifest.hs §4). */
const VIEW_AS_ITEM = ['catenary.openIn'];

/** An empty selection on a canvas: the view as the one item (a listing selection of the view), for the actions of VIEW_AS_ITEM. */
export function viewAsItem(id: string, t: ActionTarget): ActionTarget {
    return VIEW_AS_ITEM.includes(id) && !t.ids.length && t.view ? { ids: [t.view], activeView: t.activeView } : t;
}

@injectable()
export class ActionService {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    @inject(ViewEditors) protected readonly editors: ViewEditors;

    /** Answers by target key, for the current model revision. */
    protected readonly answers = new Map<string, SelectionActions>();
    /** Answers of earlier revisions, by target key: the action row of Properties shows them until the new answer arrives (`latest`). */
    protected readonly previous = new Map<string, SelectionActions>();
    protected readonly pending = new Map<string, Promise<SelectionActions>>();
    protected revision = 0;
    protected readonly onDidChangeEmitter = new Emitter<void>();
    /** An answer arrived (menus and the action row of Properties render again). */
    readonly onDidChange = this.onDidChangeEmitter.event;

    @postConstruct()
    protected init(): void {
        const reset = () => {
            this.revision++;
            for (const [key, answer] of this.answers) {
                this.previous.delete(key);
                this.previous.set(key, answer);
            }
            while (this.previous.size > 50) this.previous.delete(this.previous.keys().next().value!);
            this.answers.clear();
            this.pending.clear();
            this.prefetch();
        };
        this.model.onDidChange(s => panelsUnchanged(s.change) || reset());
        this.selection.onDidChange(() => this.prefetch());
        this.editors.onDidChangeCurrentView(() => this.prefetch());
    }

    /** Ask for the window selection; an empty selection on a canvas: also for its view (VIEW_AS_ITEM). Menus ask synchronously. */
    protected prefetch(): void {
        const t = this.selectionTarget();
        void this.fetch(t);
        if (!t.ids.length && t.view) void this.fetch(viewAsItem(VIEW_AS_ITEM[0], t));
    }

    /** The target of the window selection: its view (a selection made on a canvas) and the active view (Add to view). */
    selectionTarget(): ActionTarget {
        const { view, ids } = this.selection.selection;
        return { view, ids, activeView: this.editors.currentViewId() };
    }

    /** Resolves when the views of the selection ("Go to" submenu) are known. */
    occurrenceKnown(): Promise<void> {
        return this.editors.occurrenceKnown;
    }

    /** `arg` when it is an explicit target (with the active view), else the window selection. */
    targetOf(arg?: unknown): ActionTarget {
        return isActionTarget(arg) ? { ...arg, activeView: arg.activeView ?? this.editors.currentViewId() } : this.selectionTarget();
    }

    /** The last answer for a target, if it arrived; else asks for it and returns nothing for now. */
    get(target: ActionTarget): SelectionActions {
        const answer = this.answers.get(targetKey(target));
        if (!answer) void this.fetch(target);
        return answer ?? EMPTY;
    }

    /**
     * As `get`, but while the answer for the current revision is on the way: the answer of an earlier revision. For a display that must
     * not empty itself at each model change (the action row of Properties). Menus and commands use `get` or `fetch`.
     */
    latest(target: ActionTarget): SelectionActions {
        const answer = this.answers.get(targetKey(target));
        if (answer) return answer;
        void this.fetch(target);
        return this.previous.get(targetKey(target)) ?? EMPTY;
    }

    state(id: string, target: ActionTarget): ActionState | undefined {
        return this.get(target).actions.find(a => a.id === id);
    }

    items(target: ActionTarget): ItemFacts[] {
        return this.get(target).items;
    }

    /** Ask the backend for a target (once per target and revision). */
    fetch(target: ActionTarget): Promise<SelectionActions> {
        const key = targetKey(target);
        const known = this.answers.get(key);
        if (known) return Promise.resolve(known);
        let p = this.pending.get(key);
        if (!p) {
            const revision = this.revision;
            p = (this.model.isOpen && target.ids.length ? this.model.service.selectionActions(target) : Promise.resolve(EMPTY))
                .catch(() => EMPTY)
                .then(answer => {
                    if (revision === this.revision) {
                        this.answers.set(key, answer);
                        this.pending.delete(key);
                        this.onDidChangeEmitter.fire();
                    }
                    return answer;
                });
            this.pending.set(key, p);
        }
        return p;
    }
}

/** Wait for the actions of `target` (at most `ms`): a context menu renders synchronously, so it opens after the answer. */
export function whenActionsKnown(service: ActionService, target: ActionTarget, ms = 500): Promise<unknown> {
    return Promise.race([Promise.all([service.fetch(target), service.occurrenceKnown()]), new Promise(resolve => setTimeout(resolve, ms))]);
}
