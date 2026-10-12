// The cut mark in a view editor (cut-mark.ts, spec/ui-manifest.hs §5.8): the canvas of the source view dims the marked placements
// and their edges, Escape on a canvas clears the mark, and the paste reply of the server shows its counts and clears the mark.

import {
    Action, CommandExecutionContext, CommandReturn, GModelElement, GModelRoot, IActionDispatcher, IActionHandler, IDiagramOptions,
    IDiagramStartup, IVNodePostprocessor, SystemCommand, TYPES, ViewerOptions, setClass
} from '@eclipse-glsp/client';
import { MessageService } from '@theia/core';
import { inject, injectable, preDestroy } from '@theia/core/shared/inversify';
import type { VNode } from 'snabbdom';
import { PasteResultAction, viewIdOfUri } from '../../common/protocol';
import { ALREADY_IN_VIEW, CutMark, pasteMessage } from './cut-mark';

export const CUT_MARK_CLASS = 'cut-marked';

/** Draw the canvas again after a change of the mark. */
export interface CutMarkRedrawAction extends Action {
    kind: typeof CutMarkRedrawAction.KIND;
}
export namespace CutMarkRedrawAction {
    export const KIND = 'catenaryCutMarkRedraw';
    export const create = (): CutMarkRedrawAction => ({ kind: KIND });
}

/** A local command: it changes no model element, and the viewer draws the canvas again after it (as HighlightCommand). */
@injectable()
export class CutMarkRedrawCommand extends SystemCommand {
    static readonly KIND = CutMarkRedrawAction.KIND;

    execute(context: CommandExecutionContext): CommandReturn {
        return context.root;
    }

    undo(context: CommandExecutionContext): GModelRoot {
        return context.root;
    }

    redo(context: CommandExecutionContext): GModelRoot {
        return context.root;
    }
}

/** Adds the mark class to each marked placement of this canvas, and to each edge with a marked end, on each render. */
@injectable()
export class CutMarkPostprocessor implements IVNodePostprocessor {
    @inject(CutMark) protected readonly mark: CutMark;
    @inject(TYPES.IDiagramOptions) protected readonly options: IDiagramOptions;

    decorate(vnode: VNode, element: GModelElement): VNode {
        if (!this.mark.marked) return vnode;
        const view = viewIdOfUri(this.options.sourceUri ?? '');
        const { sourceId, targetId } = element as GModelElement & { sourceId?: string; targetId?: string };
        if (this.mark.has(view, element.id) || (sourceId && this.mark.has(view, sourceId)) || (targetId && this.mark.has(view, targetId))) {
            setClass(vnode, CUT_MARK_CLASS, true);
        }
        return vnode;
    }

    postUpdate(): void {
        // Nothing after the update: the class is part of the drawing.
    }
}

/**
 * After the first model: the canvas draws again when the mark enters or leaves its view, and Escape on the canvas clears the mark.
 * Escape is consumed only when a mark is set. The key listener is on the window in the capture phase: Theia reads keys on the
 * document first, and Escape there hides the message of the cut. Both listeners end with the diagram container (unbindAll on close).
 */
@injectable()
export class CutMarkStartup implements IDiagramStartup {
    @inject(CutMark) protected readonly mark: CutMark;
    @inject(TYPES.IActionDispatcher) protected readonly dispatcher: IActionDispatcher;
    @inject(TYPES.ViewerOptions) protected readonly viewer: ViewerOptions;
    @inject(TYPES.IDiagramOptions) protected readonly options: IDiagramOptions;
    protected listener?: { dispose(): void };
    protected onKey?: (event: KeyboardEvent) => void;

    postRequestModel(): void {
        const base = document.getElementById(this.viewer.baseDiv);
        if (!base || this.listener) return;
        const view = viewIdOfUri(this.options.sourceUri ?? '');
        this.listener = this.mark.onDidChange(before => {
            if (before.view === view || this.mark.view === view) void this.dispatcher.dispatch(CutMarkRedrawAction.create());
        });
        this.onKey = event => {
            if (event.key !== 'Escape' || !this.mark.marked || !base.contains(event.target as Node)) return;
            this.mark.apply({ kind: 'escape' });
            event.preventDefault();
            event.stopPropagation();
        };
        window.addEventListener('keydown', this.onKey, true);
    }

    @preDestroy()
    dispose(): void {
        this.listener?.dispose();
        if (this.onKey) window.removeEventListener('keydown', this.onKey, true);
    }
}

/** The paste reply of the server: one status message with its counts. A paste of a cut clip that moved or found all clears the mark. */
@injectable()
export class PasteResultHandler implements IActionHandler {
    @inject(CutMark) protected readonly mark: CutMark;
    @inject(MessageService) protected readonly messages: MessageService;

    handle(action: Action): void {
        const r = action as PasteResultAction;
        const cutAll = r.mode === 'cut' && r.alreadyInView;
        this.messages.info(cutAll ? ALREADY_IN_VIEW : pasteMessage(r.placed, r.skipped, r.missing));
        if (r.mode === 'cut') this.mark.apply({ kind: 'paste', outcome: r.alreadyInView ? 'alreadyInView' : 'moved' });
    }
}
