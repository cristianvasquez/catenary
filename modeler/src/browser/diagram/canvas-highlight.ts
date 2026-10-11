// The highlight of a view editor (spec/ui-manifest.hs §3.3 law_oneSelectionPerWindow): the diagram ids that show the window selection
// in a canvas that is not its origin. A highlight is a CSS class, not a GLSP selection: it sends no SelectAction and no selection event.
// DiagramSelectionSync (selection-sync.ts) sets it from the client model that the canvas keeps; nothing goes to the server.

import {
    Action, CommandExecutionContext, CommandReturn, GModelElement, GModelRoot, IVNodePostprocessor, SystemCommand, TYPES, setClass
} from '@eclipse-glsp/client';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { VNode } from 'snabbdom';

export const HIGHLIGHT_CLASS = 'catenary-highlight';

/** The highlighted diagram ids of one view editor (a singleton of its diagram container). */
@injectable()
export class CanvasHighlight {
    ids: ReadonlySet<string> = new Set();
}

/** Set the highlight and draw the canvas again (also with the same ids: the halo of the origin reads the frontend document). */
export interface HighlightAction extends Action {
    kind: typeof HighlightAction.KIND;
    ids: string[];
}
export namespace HighlightAction {
    export const KIND = 'catenaryHighlight';
    export const create = (ids: string[]): HighlightAction => ({ kind: KIND, ids });
}

/** A local command: it changes no model element, and the viewer draws the canvas again after it. */
@injectable()
export class HighlightCommand extends SystemCommand {
    static readonly KIND = HighlightAction.KIND;
    @inject(CanvasHighlight) protected readonly highlight: CanvasHighlight;

    constructor(@inject(TYPES.Action) protected readonly action: HighlightAction) {
        super();
    }

    execute(context: CommandExecutionContext): CommandReturn {
        this.highlight.ids = new Set(this.action.ids);
        return context.root;
    }

    undo(context: CommandExecutionContext): GModelRoot {
        return context.root;
    }

    redo(context: CommandExecutionContext): GModelRoot {
        return context.root;
    }
}

/** Adds the highlight class to the drawing of each highlighted element, on each render (also after a server update). */
@injectable()
export class HighlightPostprocessor implements IVNodePostprocessor {
    @inject(CanvasHighlight) protected readonly highlight: CanvasHighlight;

    decorate(vnode: VNode, element: GModelElement): VNode {
        if (this.highlight.ids.has(element.id)) setClass(vnode, HIGHLIGHT_CLASS, true);
        return vnode;
    }

    postUpdate(): void {
        // Nothing after the update: the class is part of the drawing.
    }
}
