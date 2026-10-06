// Members of a value set card that the server has not confirmed yet: "+ concept" / "+ member" shows the new row at once
// (pending-members-state.ts). Each new model keeps the row until the server model has a member with that label; a failed command or
// 5 s without a confirmation removes it.

import { Action, CommandExecutionContext, CommandReturn, FeedbackCommand, IActionHandler, IFeedbackActionDispatcher, TYPES } from '@eclipse-glsp/client';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ModelRoot, PendingMembersState } from './pending-members-state';

/** Add (`add`: true) or remove a pending member `label` of the value set card `set`. */
export interface PendingMemberAction extends Action {
    kind: typeof PendingMemberAction.KIND;
    /** The id of the card in the diagram (its placement). */
    set: string;
    label: string;
    add: boolean;
}
export namespace PendingMemberAction {
    export const KIND = 'catenaryPendingMember';
    export const create = (set: string, label: string, add: boolean): PendingMemberAction => ({ kind: KIND, set, label, add });
}

interface ApplyPendingMembersAction extends Action {
    kind: typeof APPLY_KIND;
}
const APPLY_KIND = 'catenaryApplyPendingMembers';

@injectable()
export class PendingMembers implements IActionHandler {
    @inject(TYPES.IFeedbackActionDispatcher) protected readonly feedback: IFeedbackActionDispatcher;
    readonly state = new PendingMembersState();
    protected readonly emitter = {};

    handle(action: Action): void {
        const a = action as PendingMemberAction;
        if (a.add) this.state.add(a.set, a.label); else this.state.remove(a.set, a.label);
        // Registering again applies the feedback to the current model at once (the row appears, or leaves).
        this.feedback.registerFeedback(this.emitter, [{ kind: APPLY_KIND } as ApplyPendingMembersAction]);
    }
}

/** The feedback command: runs on each new model (FeedbackAwareUpdateModelCommand) and when a pending member is added or removed. */
@injectable()
export class ApplyPendingMembersCommand extends FeedbackCommand {
    static readonly KIND = APPLY_KIND;
    @inject(PendingMembers) protected readonly pending: PendingMembers;

    constructor(@inject(TYPES.Action) protected readonly action: ApplyPendingMembersAction) {
        super();
    }

    execute(context: CommandExecutionContext): CommandReturn {
        this.pending.state.apply(context.root as unknown as ModelRoot);
        return context.root;
    }
}
