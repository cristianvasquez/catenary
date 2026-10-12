// The mark of a cut (spec/ui-manifest.hs §5.8): Ctrl+X marks the clip and dims its source placements; nothing changes in the model.
// A paste of the cut clip moves the elements in one command (moveBetweenViews). The mark is window state: one for all canvases of
// the window, no command and no undo step. cut-mark-canvas.ts draws it and reads Escape and the paste reply.

import { Emitter } from '@theia/core/lib/common/event';

/** The marked clip: the source view, the diagram ids of its placements in that view, the clip id. No view: no mark. */
export interface CutMarkState {
    view?: string;
    ids: ReadonlySet<string>;
    clipboardId?: string;
}

/** The outcome of a paste of the marked clip. A refused paste keeps the mark. */
export type PasteOutcome = 'moved' | 'alreadyInView' | 'refused';

/** The events that change the mark (law_markClearsOnEvents). Undo runs no clipboard step: it keeps the mark. */
export type MarkEvent =
    | { kind: 'cut'; view: string; ids: readonly string[]; clipboardId: string }
    | { kind: 'copy' }
    | { kind: 'escape' }
    | { kind: 'close' }
    | { kind: 'undo' }
    | { kind: 'paste'; outcome: PasteOutcome };

export const NO_MARK: CutMarkState = { ids: new Set() };

/** The mark after an event: a cut replaces it; a copy, Escape, a window close and a paste that moved or found all clear it. */
export function markAfter(mark: CutMarkState, event: MarkEvent): CutMarkState {
    switch (event.kind) {
        case 'cut': return { view: event.view, ids: new Set(event.ids), clipboardId: event.clipboardId };
        case 'undo': return mark;
        case 'paste': return event.outcome === 'refused' ? mark : NO_MARK;
        default: return NO_MARK;
    }
}

const elements = (n: number) => n === 1 ? '1 element' : `${n} elements`;

/** The status message of a cut of `n` elements. */
export function cutMessage(n: number): string {
    return `${elements(n)} cut. Paste moves ${n === 1 ? 'it' : 'them'}. Escape cancels.`;
}

/** The status message of a paste: the placed count, then the skipped and the missing counts when they are not zero. */
export function pasteMessage(placed: number, skipped: number, missing: number): string {
    return `Placed ${placed}.` + (skipped ? ` Skipped ${skipped} already in this view.` : '') + (missing ? ` ${missing} missing from this model.` : '');
}

/** The message of a paste of a cut clip into a canvas that shows all of its elements. */
export const ALREADY_IN_VIEW = 'Already in this view.';

/** The mark of the window. `onDidChange` gives the mark before the change: a canvas draws again when it showed or shows the mark. */
export class CutMark implements CutMarkState {
    protected state: CutMarkState = NO_MARK;
    protected readonly changed = new Emitter<CutMarkState>();
    readonly onDidChange = this.changed.event;

    get view(): string | undefined { return this.state.view; }
    get ids(): ReadonlySet<string> { return this.state.ids; }
    get clipboardId(): string | undefined { return this.state.clipboardId; }
    get marked(): boolean { return this.state.view !== undefined; }

    apply(event: MarkEvent): void {
        const before = this.state;
        this.state = markAfter(before, event);
        if (this.state !== before) this.changed.fire(before);
    }

    set(view: string, ids: readonly string[], clipboardId: string): void {
        this.apply({ kind: 'cut', view, ids, clipboardId });
    }

    clear(): void {
        if (this.marked) this.apply({ kind: 'copy' });
    }

    /** True when a canvas of `view` dims the diagram element `id`. */
    has(view: string | undefined, id: string): boolean {
        return view !== undefined && this.state.view === view && this.state.ids.has(id);
    }
}

/** The one mark of the window: every view editor reads it. A window close discards it with the window. */
export const cutMark = new CutMark();
