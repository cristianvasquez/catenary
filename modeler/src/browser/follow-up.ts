// Follow-up of a creation (spec/ui-manifest.hs §4): the new element is selected where the gesture was made, and its first editable
// field gets the keyboard focus with the default value selected. On a canvas: the name slot of its card, or the note editor. Else the
// field of the Element section (Properties) that carries `data-catenary-field`; else a label dialog. Enter accepts, Escape keeps the
// default value (it cancels the edit, not the creation). The typed value is a second undo step. No field found: the caller asks for
// the label in a dialog (ModelActions.rename).

import { ApplicationShell } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { PropertyViewWidget } from '@theia/property-view/lib/browser/property-view-widget';
import { editCanvasName } from './diagram/name-edit';
import { ViewEditors } from './diagram/view-editors';
import { ModelFrontend } from './model-client';
import { NoteEditor } from './notes/note-editor';
import { SelectionModel } from './selection-model';

/** The first editable field of a new element: its label, the path of a property shape, the text of a note. */
export type FollowUpField = 'label' | 'path' | 'text';

/** Wait for `find` to return a value, one animation frame at a time, at most `frames` frames. */
function untilFound<T>(find: () => T | undefined, frames = 120): Promise<T | undefined> {
    return new Promise(resolve => {
        let n = 0;
        const step = () => {
            const v = find();
            if (v !== undefined || ++n >= frames) resolve(v);
            else requestAnimationFrame(step);
        };
        step();
    });
}

@injectable()
export class FollowUp {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(NoteEditor) protected readonly notes: NoteEditor;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;

    /**
     * After the element `id` was created. `view`: the gesture was on that canvas (the element is placed there); none: outside a
     * canvas. The caller has selected the element on the canvas already (executeAndSelect); outside a canvas this selects it.
     * False: no field got the focus.
     */
    async created(id: string, field: FollowUpField = 'label', view?: string): Promise<boolean> {
        const w = view ? this.editors.find(view) : undefined;
        if (w && view) {
            if (field === 'text') {
                await this.notes.open(view, id);
                return true;
            }
            // The card renders after the model update: try its name slot each frame.
            if (await untilFound(() => editCanvasName(w, id, view, this.editors, this.model, true) || undefined)) return true;
        } else {
            this.selection.set({ ids: [id] });
        }
        await this.shell.revealWidget(PropertyViewWidget.ID);
        const input = await untilFound(() => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            `[data-catenary-element="${CSS.escape(id)}"] [data-catenary-field="${field}"], [data-catenary-element="${CSS.escape(id)}"][data-catenary-field="${field}"]`) ?? undefined);
        if (!input) return false;
        input.focus();
        input.select();
        return true;
    }
}
