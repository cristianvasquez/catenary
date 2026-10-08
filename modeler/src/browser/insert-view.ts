// Insert View (spec/ui-manifest.hs §9): in a text editor of a Markdown file, pick a view by its label and insert its embed at the cursor.
// The embed stores the view IRI (@catenary/model viewEmbed), not the label and not the element id.

import { MessageService, QuickInputService, QuickPickItem } from '@theia/core';
import { inject, injectable } from '@theia/core/shared/inversify';
import { EditorManager, TextEditor } from '@theia/editor/lib/browser';
import { dirName, idIri, isMarkdownPath, relativePath, viewEmbed } from '@catenary/model';
import { ModelFrontend } from './model-client';

@injectable()
export class InsertView {
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(QuickInputService) protected readonly quickInput: QuickInputService;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(MessageService) protected readonly messages: MessageService;

    /** The current text editor when it shows a Markdown file that can change. */
    editor(): TextEditor | undefined {
        const editor = this.editorManager.currentEditor?.editor;
        return editor && editor.uri.scheme === 'file' && isMarkdownPath(editor.uri.path.base) && !editor.isReadonly ? editor : undefined;
    }

    /** Pick a view (or use the view with IRI `iri`) and insert its embed at the cursor. Returns the inserted text. */
    async insert(iri?: string): Promise<string | undefined> {
        const editor = this.editor();
        if (!editor) return undefined;
        const views = (await this.model.viewsSorted()).map(v => ({ ...v, iri: idIri(v.id) })).filter((v): v is typeof v & { iri: string } => !!v.iri);
        const view = iri ? views.find(v => v.iri === iri) : (await this.quickInput.showQuickPick<QuickPickItem & { iri: string }>(
            views.map(v => ({ label: v.label, description: this.folderOf(v.id), detail: v.iri, iri: v.iri })),
            { placeholder: 'Select the view to insert at the cursor' }));
        if (!view) {
            if (iri) this.messages.error(`No view with the IRI ${iri}.`);
            return undefined;
        }
        const text = viewEmbed(view.label, view.iri);
        const { start, end } = editor.selection;
        editor.executeEdits([{ range: { start, end }, newText: text }]);
        editor.focus();
        return text;
    }

    /** The folder of the file of a view, relative to the workspace folder. */
    protected folderOf(view: string): string {
        const { file, files } = this.model.snapshot;
        const path = files.views.find(f => f.view === view)?.path;
        const rel = path && file ? relativePath(dirName(file), path) : undefined;
        return rel?.includes('/') ? rel.replace(/\/[^/]*$/, '') : '';
    }
}
