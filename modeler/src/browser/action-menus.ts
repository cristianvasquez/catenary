// Context menus that show the actions of a selection (action-commands.ts) render synchronously: they open after the answer of the
// backend for the selection arrived (at most 500 ms), so that the first right click shows the actions of the new selection.

import { ClientMenuItem } from '@eclipse-glsp/client';
import { TheiaContextMenuService } from '@eclipse-glsp/theia-integration';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ActionService, whenActionsKnown } from './action-service';

type Anchor = Parameters<TheiaContextMenuService['show']>[1];

/** The context menu of a view editor: GLSP selects the element under the pointer, then this waits for its actions. */
@injectable()
export class WaitingContextMenuService extends TheiaContextMenuService {
    @inject(ActionService) protected readonly actions: ActionService;

    override show(items: ClientMenuItem[], anchor: Anchor, onHide?: () => void): void {
        // The selection forwarder runs on the GLSP selection change, before the menu request: the target is the new selection.
        void whenActionsKnown(this.actions, this.actions.selectionTarget()).then(() => super.show(items, anchor, onHide));
    }
}
