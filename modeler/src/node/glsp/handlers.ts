// GLSP operation and action handlers. Each operation becomes one EditCommand on the shared store.
// Handlers return no GLSP command: the store keeps the undo stack (see StoreCommandStack).

import {
    Action, ActionHandler, ChangeBoundsOperation, Command,
    CreateNodeOperation, CreateNodeOperationHandler, CutOperation, DeleteElementOperation, OperationHandler,
    PasteOperation, RedoAction, RequestClipboardDataAction, SelectAction, SetClipboardDataAction, FitToScreenAction,
    TriggerNodeCreationAction, UndoAction
} from '@eclipse-glsp/server';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    LEAF_SUFFIX, TYPES, VIEW_CLIP_FORMAT, copyFromView, isViewClip, ownerOfLabel, isTakenOut, propertyNodeId
} from '@catenary/model';
import * as model from '@catenary/model';
import { ViewSession } from './view-session';

/** Select the created element. It has a default name: rename it in place (F2) or in the properties. */
const selectCreated = (r: { id?: string }): Action[] => [SelectAction.create({ selectedElementsIDs: [r.id!], deselectedElementsIDs: true })];

/** Follow-up of a creation (spec/ui-manifest.hs §4.6): select it; the client edits its name slot, or the text of a note, after it renders. */
const renameCreated = (view: string) => (r: { id?: string }): Action[] => [
    ...selectCreated(r), { kind: 'catenaryEditCanvasName', id: r.id!, view } as Action
];

@injectable()
export class CreateCardHandler extends OperationHandler implements CreateNodeOperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = CreateNodeOperation.KIND;
    readonly elementTypeIds = [TYPES.CARD];
    readonly label = 'Instance';

    getTriggerActions(): TriggerNodeCreationAction[] {
        return [];   // The palette items come from the shapes (see ShapesPaletteProvider).
    }

    async createCommand(op: CreateNodeOperation): Promise<Command | undefined> {
        const classIri = String(op.args?.classIri ?? '');
        const cls = this.session.store.meta.classes.find(c => c.iri === classIri);
        if (!cls) {
            this.session.message('Unknown class. Reload the shapes.');
            return undefined;
        }
        const label = this.session.store.reads.newLabel('instance', { classIri });
        const at = op.location ?? { x: 0, y: 0 };
        await this.session.edit({ kind: 'createInstance', classIri, label, view: this.session.viewId, at: {
            x: at.x + model.DEFAULT_SIZE.width / 2, y: at.y + model.DEFAULT_SIZE.height / 2
        } }, renameCreated(this.session.viewId));
        return undefined;
    }
}

/** Palette "Shape": a new node shape "unnamed shape N" in the primary shapes file, with its card. */
@injectable()
export class CreateShapeHandler extends OperationHandler implements CreateNodeOperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = CreateNodeOperation.KIND;
    readonly elementTypeIds = [TYPES.SHAPE];
    readonly label = 'Node shape';

    getTriggerActions(): TriggerNodeCreationAction[] {
        return [];   // See ShapesPaletteProvider.
    }

    async createCommand(op: CreateNodeOperation): Promise<Command | undefined> {
        const label = this.session.store.reads.newLabel('shape');
        const at = op.location ?? { x: 0, y: 0 };
        await this.session.edit({ kind: 'createNodeShape', label, view: this.session.viewId, at: { x: at.x + 130, y: at.y + 40 } }, renameCreated(this.session.viewId));
        return undefined;
    }
}

/** Palette "Scheme" (concept scheme) and "Collection" (`args.kind`): a new value set in the primary shapes file, with its node. */
@injectable()
export class CreateValueSetHandler extends OperationHandler implements CreateNodeOperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = CreateNodeOperation.KIND;
    readonly elementTypeIds = [TYPES.VALUESET];
    readonly label = 'Value set';

    getTriggerActions(): TriggerNodeCreationAction[] {
        return [];   // See ShapesPaletteProvider.
    }

    async createCommand(op: CreateNodeOperation): Promise<Command | undefined> {
        const kind = op.args?.kind === 'collection' ? 'collection' : 'scheme';
        const label = this.session.store.reads.newLabel(kind);
        const at = op.location ?? { x: 0, y: 0 };
        await this.session.edit({ kind: 'createValueSet', valueSet: kind, label, view: this.session.viewId, at: { x: at.x + 120, y: at.y + 40 } }, renameCreated(this.session.viewId));
        return undefined;
    }
}

@injectable()
export class CreateNoteHandler extends OperationHandler implements CreateNodeOperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = CreateNodeOperation.KIND;
    readonly elementTypeIds = [TYPES.NOTE];
    readonly label = 'Note';

    getTriggerActions(): TriggerNodeCreationAction[] {
        return [TriggerNodeCreationAction.create(TYPES.NOTE)];
    }

    async createCommand(op: CreateNodeOperation): Promise<Command | undefined> {
        const at = op.location ?? { x: 0, y: 0 };
        await this.session.edit({ kind: 'createNote', view: this.session.viewId, text: 'Note', at }, renameCreated(this.session.viewId));
        return undefined;
    }
}

@injectable()
export class CreateGroupHandler extends OperationHandler implements CreateNodeOperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = CreateNodeOperation.KIND;
    readonly elementTypeIds = [TYPES.GROUP];
    readonly label = 'Group';

    getTriggerActions(): TriggerNodeCreationAction[] {
        return [TriggerNodeCreationAction.create(TYPES.GROUP)];
    }

    async createCommand(op: CreateNodeOperation): Promise<Command | undefined> {
        const at = op.location ?? { x: 0, y: 0 };
        const label = this.session.store.reads.newLabel('group', { view: this.session.viewId });
        await this.session.edit({ kind: 'createGroup', view: this.session.viewId, label, rect: { x: at.x, y: at.y, width: 600, height: 400 } }, renameCreated(this.session.viewId));
        return undefined;
    }
}

@injectable()
export class ChangeBoundsHandler extends OperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = ChangeBoundsOperation.KIND;

    async createCommand(op: ChangeBoundsOperation): Promise<Command | undefined> {
        const bounds = op.newBounds.map(b => ({ id: b.elementId, x: b.newPosition?.x, y: b.newPosition?.y, width: b.newSize.width, height: b.newSize.height }));
        await this.session.edit({ kind: 'setBounds', view: this.session.viewId, bounds });
        return undefined;
    }
}

/**
 * Del in a view: cards leave the view, edges are hidden in the view, groups are deleted. The model keeps the instances.
 * Shapes view: a property taken out of its card goes back into it; rows and other property edges stay (Ctrl+Del deletes them).
 */
@injectable()
export class DeleteHandler extends OperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = DeleteElementOperation.KIND;

    async createCommand(op: DeleteElementOperation): Promise<Command | undefined> {
        const { shapes } = this.session.part;
        const view = this.session.view;
        // An "in" or "one of" box and a private pill keep their id (`<property>_leaf`): the command finds their placement or hub.
        const all = [...new Set(op.elementIds.map(id => id.endsWith(LEAF_SUFFIX) ? id : ownerOfLabel(id)))];
        // A property line: its placement (shared by the owners of a shared property). A hub member, a hub: the hub unit.
        const ids = all.flatMap(id => {
            const p = shapes.properties[id];
            if (!p) return [id];
            return p.constraint ? [id] : isTakenOut(view, p) ? [propertyNodeId(p)] : [];
        });
        if (ids.length === 0) {
            await this.session.message('A property stays in its node shape. Delete it from the shapes with Ctrl+Del.', 'INFO');
            return undefined;
        }
        await this.session.edit({ kind: 'removeFromView', view: this.session.viewId, ids });
        return undefined;
    }
}

// Copy, cut and paste between views. The client keeps the clip (one clipboard for all view editors, see
// diagram-configuration.ts) and sends it back with the paste. The client marks a cut with `args.mode = 'cut'`.
// A paste of a copy creates new instances; a paste of a cut adds the same instances to the target view, and the
// cut removes them from the source view. Cut and paste are two undo steps.

@injectable()
export class RequestClipboardDataHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [RequestClipboardDataAction.KIND];

    execute(action: RequestClipboardDataAction): Action[] {
        const ids = [...new Set(action.editorContext.selectedElementIds.map(ownerOfLabel))];
        const mode = action.editorContext.args?.mode === 'cut' ? 'cut' : 'copy';
        const clip = copyFromView(this.session.part, this.session.viewId, ids, mode);
        return [SetClipboardDataAction.create(clip ? { format: VIEW_CLIP_FORMAT, [VIEW_CLIP_FORMAT]: JSON.stringify(clip) } : {})];
    }
}

@injectable()
export class CutHandler extends OperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = CutOperation.KIND;

    async createCommand(op: CutOperation): Promise<Command | undefined> {
        await this.session.edit({ kind: 'cutFromView', view: this.session.viewId, ids: [...new Set(op.editorContext.selectedElementIds.map(ownerOfLabel))] });
        return undefined;
    }
}

@injectable()
export class PasteHandler extends OperationHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly operationType = PasteOperation.KIND;

    async createCommand(op: PasteOperation): Promise<Command | undefined> {
        let clip: unknown;
        try {
            clip = JSON.parse(op.clipboardData[VIEW_CLIP_FORMAT] ?? 'null');
        } catch {
            clip = undefined;
        }
        if (!isViewClip(clip)) {
            await this.session.message('The clipboard does not hold view elements.');
            return undefined;
        }
        const before = new Set([...this.session.store.viewFigures(this.session.viewId)!.placed.values()].map(p => model.iriId(p.iri)));
        await this.session.edit({ kind: 'pasteIntoView', view: this.session.viewId, clip, at: op.editorContext.lastMousePosition, cardScale: this.session.state.cardScale }, r => {
            const added = (r.ids ?? []).filter(id => !before.has(id));
            return [SelectAction.create({ selectedElementsIDs: r.ids ?? [], deselectedElementsIDs: true }),
                ...(added.length ? [FitToScreenAction.create(added, { padding: 40, maxZoom: 1, animate: false })] : [])];
        });
        return undefined;
    }
}

/** Undo and redo act on the shared store. The store change refreshes every session. */
@injectable()
export class StoreUndoRedoHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [UndoAction.KIND, RedoAction.KIND];

    execute(action: Action): Action[] {
        const r = UndoAction.is(action) ? this.session.store.undo() : RedoAction.is(action) ? this.session.store.redo() : undefined;
        if (r && !r.ok) void this.session.message(r.error);
        return [];
    }
}

/** Client action: the card text scale (font preference). Sent before the first model request, and again on a change. */
export interface SetCardScaleAction extends Action {
    kind: typeof SetCardScaleAction.KIND;
    scale: number;
}
export namespace SetCardScaleAction {
    export const KIND = 'catenarySetCardScale';
}

@injectable()
export class SetCardScaleHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [SetCardScaleAction.KIND];

    async execute(action: Action): Promise<Action[]> {
        const scale = (action as SetCardScaleAction).scale;
        if (!(scale > 0) || scale === this.session.state.cardScale) return [];
        this.session.state.cardScale = scale;
        // Before the first model request there is no view to send.
        if (this.session.viewId) await this.session.refresh();
        return [];
    }
}

/** Client action: show or hide the edges that are hidden in this view. */
export interface SetShowHiddenAction extends Action {
    kind: typeof SetShowHiddenAction.KIND;
    show: boolean;
}
export namespace SetShowHiddenAction {
    export const KIND = 'catenarySetShowHidden';
}

@injectable()
export class SetShowHiddenHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [SetShowHiddenAction.KIND];

    async execute(action: Action): Promise<Action[]> {
        this.session.state.showHidden = (action as SetShowHiddenAction).show;
        await this.session.refresh();
        return [];
    }
}
