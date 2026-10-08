// Edit > Cut, Copy and Paste (and Ctrl+X / Ctrl+C) in a view editor. Theia runs document.execCommand for these,
// which the browser refuses for a paste from a menu. These handlers call the copy-paste handler of the view editor
// with a clipboard event of their own. The clip is also written to the system clipboard, for a later Ctrl+V.

import { TYPES } from '@eclipse-glsp/client';
import type { ICopyPasteHandler } from '@eclipse-glsp/client';
import { CommandRegistry, MessageService } from '@theia/core';
import { ApplicationShell, CommonCommands, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { VIEW_SCHEME } from '../../common/protocol';
import { ModelCommands } from '../commands';
import { ModelFrontend } from '../model-client';
import { SelectionModel } from '../selection-model';
import { viewIdOf } from './view-editors';

@injectable()
export class ViewClipboard implements FrontendApplicationContribution {
    @inject(CommandRegistry) protected readonly commands: CommandRegistry;
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    @inject(MessageService) protected readonly messages: MessageService;

    /** Text of the last cut or copy in a view editor: the clip id that the paste looks up. */
    protected last?: string;

    /** After the Theia handlers: the newest handler of a command runs first. */
    onDidInitializeLayout(): void {
        const enabled = () => !!this.editor();
        this.commands.registerHandler(CommonCommands.CUT.id, { execute: () => this.run('cut'), isEnabled: enabled });
        this.commands.registerHandler(CommonCommands.COPY.id, { execute: () => this.run('copy'), isEnabled: enabled });
        this.commands.registerHandler(CommonCommands.PASTE.id, { execute: () => this.run('paste'), isEnabled: enabled });
        this.commands.registerCommand(ModelCommands.COPY_AS_RDF, {
            execute: () => this.copyAsRdf(),
            isEnabled: () => !!this.editor() && this.selection.selection.view === viewIdOf(this.editor()!) && this.selection.selection.ids.length > 0,
            isVisible: enabled
        });
    }

    /** The view editor that is the current widget of the shell. */
    protected editor(): GLSPDiagramWidget | undefined {
        const w = this.shell.currentWidget;
        return w instanceof GLSPDiagramWidget && w.uri.scheme === VIEW_SCHEME ? w : undefined;
    }

    protected async run(kind: 'cut' | 'copy' | 'paste'): Promise<void> {
        const w = this.editor();
        if (!w) return;
        // A menu click can take the focus; the handler acts only when the view editor has it.
        await this.shell.activateWidget(w.id);
        const handler = w.diContainer.get<ICopyPasteHandler>(TYPES.ICopyPasteHandler);
        const data = new DataTransfer();
        if (kind === 'paste') {
            // Read the current system clipboard: external RDF must replace an earlier canvas clip.
            let text: string | undefined;
            try { text = await navigator.clipboard?.readText(); }
            catch { text = this.last; }
            if (text === undefined) { this.messages.warn('Cannot read the clipboard. Use Ctrl+V in the canvas.'); return; }
            data.setData('text/plain', text);
            handler.handlePaste(new ClipboardEvent('paste', { clipboardData: data }));
            return;
        }
        const event = new ClipboardEvent(kind, { clipboardData: data });
        if (kind === 'cut') handler.handleCut(event);
        else handler.handleCopy(event);
        const text = data.getData('text/plain');
        if (!text) return;
        this.last = text;
        await navigator.clipboard?.writeText(text).catch(() => undefined);
    }

    protected async copyAsRdf(): Promise<void> {
        const w = this.editor();
        if (!w) return;
        const view = viewIdOf(w), ids = this.selection.selection.ids;
        if (!view || this.selection.selection.view !== view) return;
        try {
            const r = await this.model.service.copyAsRdf(view, ids);
            if (!r.ok) { this.messages.warn(r.error); return; }
            if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.');
            await navigator.clipboard.writeText(r.text);
            this.last = r.text;
        } catch (e) { this.messages.warn(`Cannot copy RDF: ${e instanceof Error ? e.message : String(e)}`); }
    }
}
