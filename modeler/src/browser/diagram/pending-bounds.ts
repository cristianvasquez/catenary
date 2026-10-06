// Moves and resizes that the server has not confirmed yet. The canvas shows a drop at once; the server confirms it with a model
// update. An update that the server sent before it applied the last drop (a fast second drag) has the older bounds: the box would
// jump back, then forward. PendingBounds keeps the bounds of each box that this client moved or resized, and draws them on each new
// server model until that model has them (pending-bounds-state.ts). A drop that the server does not confirm in 3 s gives way to the
// server model.

import {
    Action, ChangeBoundsOperation, CommandExecutionContext, CommandReturn, CompoundOperation, FeedbackCommand, IActionHandler, IFeedbackActionDispatcher, TYPES
} from '@eclipse-glsp/client';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ModelRoot, PendingBoundsState } from './pending-bounds-state';

export interface ApplyPendingBoundsAction extends Action {
    kind: typeof ApplyPendingBoundsAction.KIND;
}
export namespace ApplyPendingBoundsAction {
    export const KIND = 'catenaryApplyPendingBounds';
    export const create = (): ApplyPendingBoundsAction => ({ kind: KIND });
}

/** Records each ChangeBoundsOperation that this client sends (also in a CompoundOperation), and keeps the feedback registered. */
@injectable()
export class PendingBounds implements IActionHandler {
    @inject(TYPES.IFeedbackActionDispatcher) protected readonly feedback: IFeedbackActionDispatcher;
    readonly state = new PendingBoundsState();
    protected readonly emitter = {};

    handle(action: Action): void {
        // The move tool sends its ChangeBoundsOperation in a CompoundOperation; the resize tool sends it alone.
        const operations = CompoundOperation.is(action) ? action.operationList : [action];
        for (const op of operations) if (ChangeBoundsOperation.is(op)) this.record(op);
    }

    protected record(action: ChangeBoundsOperation): void {
        const at = Date.now();
        for (const b of action.newBounds) {
            const bounds = { x: b.newPosition?.x ?? 0, y: b.newPosition?.y ?? 0, width: b.newSize.width, height: b.newSize.height };
            if (!b.newPosition) continue;
            const entry = this.state.sent.get(b.elementId);
            if (entry) {
                entry.bounds.push(bounds);
                entry.at = at;
            } else this.state.sent.set(b.elementId, { bounds: [bounds], at });
        }
        this.feedback.registerFeedback(this.emitter, [ApplyPendingBoundsAction.create()]);
    }
}

/** The feedback command: runs on each new model (FeedbackAwareUpdateModelCommand) before it renders. */
@injectable()
export class ApplyPendingBoundsCommand extends FeedbackCommand {
    static readonly KIND = ApplyPendingBoundsAction.KIND;
    @inject(PendingBounds) protected readonly pending: PendingBounds;

    constructor(@inject(TYPES.Action) protected readonly action: ApplyPendingBoundsAction) {
        super();
    }

    execute(context: CommandExecutionContext): CommandReturn {
        this.pending.state.apply(context.root as unknown as ModelRoot);
        return context.root;
    }
}
