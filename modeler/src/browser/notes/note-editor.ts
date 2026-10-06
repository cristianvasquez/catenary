// A compact, non-modal editor for a view note. Ctrl+Enter or a click outside commits one guarded model edit; Escape cancels.
import { CommandRegistry, DisposableCollection, InMemoryResources, MessageService } from '@theia/core';
import URI from '@theia/core/lib/common/uri';
import { KeybindingRegistry } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { MonacoEditorProvider } from '@theia/monaco/lib/browser/monaco-editor-provider';
import { SimpleMonacoEditor } from '@theia/monaco/lib/browser/simple-monaco-editor';
import * as monaco from '@theia/monaco-editor-core';
import { boxOf } from '@catenary/model';
import { colorValue } from '../diagram/card-chrome';
import { ModelFrontend } from '../model-client';

function ensureMarkdown(): void {
    if (monaco.languages.getLanguages().some(l => l.id === 'markdown')) return;
    monaco.languages.register({ id: 'markdown', extensions: ['.md'], aliases: ['Markdown'] });
    monaco.languages.setMonarchTokensProvider('markdown', {
        tokenizer: {
            root: [
                [/^\s*(```|~~~).*$/, 'string', '@code'], [/^#{1,6}\s.*$/, 'keyword'],
                [/^\s*>/, 'comment'], [/^\s*(?:[-+*]|\d+\.)\s/, 'keyword'],
                [/`[^`]+`/, 'string'], [/\*\*[^*]+\*\*|__[^_]+__/, 'strong'],
                [/\*[^*]+\*|_[^_]+_/, 'emphasis'], [/!?\[[^\]]*\]\([^)]*\)/, 'string.link']
            ],
            code: [[/^\s*(```|~~~)\s*$/, 'string', '@pop'], [/.*$/, 'string']]
        }
    });
}

@injectable()
export class NoteEditor {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(MonacoEditorProvider) protected readonly editors: MonacoEditorProvider;
    @inject(InMemoryResources) protected readonly resources: InMemoryResources;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(CommandRegistry) protected readonly commands: CommandRegistry;
    @inject(KeybindingRegistry) protected readonly keys: KeybindingRegistry;
    protected active?: { node: HTMLElement; close: () => Promise<void> };

    async open(view: string, id: string, anchor?: Element): Promise<void> {
        if (this.active) {
            if (this.active.node.isConnected) this.active.node.querySelector<HTMLElement>('.monaco-editor')?.focus();
            return;
        }
        const note = boxOf(await this.model.service.view(view), id);
        // Another call opened an editor while the backend answered.
        if (note?.kind !== 'note' || this.active) return;
        const original = note.text;
        const file = this.model.snapshot.file;
        const host = document.createElement('div');
        host.className = 'catenary-note-popover';
        const color = colorValue(note.color);
        if (color) host.style.setProperty('--c', color);
        host.setAttribute('role', 'dialog');
        host.setAttribute('aria-label', 'Edit note Markdown');
        const editorHost = document.createElement('div');
        editorHost.className = 'catenary-note-source';
        const error = document.createElement('div');
        error.className = 'catenary-note-error';
        error.setAttribute('role', 'alert');
        host.append(editorHost, error);
        document.body.appendChild(host);
        const rect = (anchor ?? [...document.querySelectorAll('.catenary-note')].find(el =>
            el.id.endsWith(`_${id}`) && el.closest('[id^="catenary-view"]')))?.getBoundingClientRect();
        const width = Math.min(440, window.innerWidth - 24);
        host.style.width = `${width}px`;
        host.style.left = `${Math.max(12, Math.min(rect?.left ?? (window.innerWidth - width) / 2, window.innerWidth - width - 12))}px`;
        host.style.top = `${Math.max(12, Math.min(rect?.top ?? window.innerHeight / 3, window.innerHeight - 320))}px`;

        const cleanup = new DisposableCollection();
        let editor: SimpleMonacoEditor | undefined;
        let closing = false;
        let disposed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            cleanup.dispose();
            host.remove();
            this.active = undefined;
        };
        const close = async () => {
            if (closing || !editor) return;
            closing = true;
            error.textContent = '';
            const text = editor.getControl().getValue();
            try {
                if (text !== original) {
                    if (this.model.snapshot.file !== file || boxOf(await this.model.service.view(view), id)?.kind !== 'note') {
                        error.textContent = 'The model or note changed. Copy your draft before closing.';
                        return;
                    }
                    const result = await this.model.execute({ kind: 'setViewElements', view, ids: [id], patch: { text }, expectedText: original });
                    if (!result.ok) { error.textContent = result.error; return; }
                }
                dispose();
            } finally {
                closing = false;
            }
        };
        this.active = { node: host, close };
        const outside = (event: PointerEvent) => {
            if (!host.contains(event.target as Node)) void close();
        };
        // Escape cancels: the draft goes, the note does not change (spec 0.4). Ctrl+Enter and a click outside save.
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                dispose();
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                event.stopPropagation();
                void close();
            }
        };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', keydown, true);
        cleanup.push({ dispose: () => {
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('keydown', keydown, true);
        } });
        // The view editor stays the current widget: without these, its keybindings (undo, select all) act on the diagram.
        const draftKeys = { undo: ['ctrlcmd+z'], redo: ['ctrlcmd+shift+z', 'ctrlcmd+y'], selectAll: ['ctrlcmd+a'], save: ['ctrlcmd+s'] };
        for (const [action, shortcuts] of Object.entries(draftKeys)) {
            const command = `catenary.noteDraft.${action}`;
            cleanup.push(this.commands.registerCommand({ id: command }, { execute: () => {
                const model = editor?.getControl().getModel();
                if (action === 'undo') void model?.undo();
                if (action === 'redo') void model?.redo();
                if (action === 'selectAll' && model) editor!.getControl().setSelection(model.getFullModelRange());
                // Save requires closing the editor first; no draft leaks to the model.
            } }));
            for (const keybinding of shortcuts) cleanup.push(this.keys.registerKeybinding({ command, keybinding }));
        }
        try {
            ensureMarkdown();
            const uri = new URI(`catenary-note-draft:/${crypto.randomUUID()}.md`);
            cleanup.push(this.resources.add(uri, original));
            editor = await this.editors.createSimpleInline(uri, editorHost, {
                wordWrap: 'on', fontSize: 16, padding: { top: 10, bottom: 10 },
                ariaLabel: 'Note Markdown source', quickSuggestions: false, wordBasedSuggestions: 'off',
                renderValidationDecorations: 'off', contextmenu: false, editContext: false
            });
            if (disposed) { editor.dispose(); return; }
            cleanup.push(editor);
            editor.setLanguage('markdown');
            editor.refresh();
            editor.focus();
        } catch (e) {
            dispose();
            this.messages.error(`Cannot edit note: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
