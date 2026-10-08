// One editing surface per view: a Properties field or a native Theia Markdown editor.
import { Emitter, MessageService } from '@theia/core';
import { ApplicationShell, FormatType, FrontendApplicationContribution, SaveableWidget, SaveReason } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import { ModelFrontend } from '../model-client';
import { ViewEditors } from '../diagram/view-editors';
import { SelectionModel } from '../selection-model';
import { ensureMarkdown } from './note-editor';
import { notesTarget, notesUri, VIEW_NOTES_SCHEME } from './view-notes-resource';

export function ViewNotesField(p: { model: ModelFrontend; editors: ViewNotesEditors; view: string; value: string }) {
    const [text, setText] = React.useState(p.value);
    const original = React.useRef(p.value);
    const latest = React.useRef(p.value);
    const [error, setError] = React.useState('');
    const [, redraw] = React.useReducer(n => n + 1, 0);
    const file = React.useRef(p.model.snapshot.file);
    const pending = React.useRef<Promise<boolean>>();
    const detached = p.editors.has(p.view);
    React.useEffect(() => {
        const subscription = p.editors.onDidChange(() => redraw());
        return () => subscription.dispose();
    }, [p.editors]);
    React.useEffect(() => {
        if (latest.current === original.current) {
            latest.current = original.current = p.value;
            setText(p.value);
        }
    }, [p.value]);
    const save = (): Promise<boolean> => {
        if (pending.current) return pending.current;
        if (latest.current === original.current) return Promise.resolve(true);
        if (p.model.snapshot.file !== file.current) {
            setError('The workspace changed. Copy your notes before leaving this field.');
            return Promise.resolve(false);
        }
        const operation = (async () => {
            while (latest.current !== original.current) {
                if (p.model.snapshot.file !== file.current) return false;
                const value = latest.current;
                const result = await p.model.execute({ kind: 'setViewDescription', view: p.view, text: value, expectedText: original.current });
                if (!result.ok) { setError(result.error); return false; }
                original.current = value;
                setError('');
            }
            return true;
        })().finally(() => { pending.current = undefined; });
        pending.current = operation;
        return operation;
    };
    return <div className='catenary-view-notes'>
        <div className='catenary-notes-tools'><button className='catenary-tool' title={detached ? 'Show notes editor' : 'Open notes in editor'}
            aria-label={detached ? 'Show notes editor' : 'Open notes in editor'}
            onClick={() => { void (async () => { if (await save()) await p.editors.open(p.view); })(); }}>
            <span className='codicon codicon-link-external' aria-hidden='true' />
        </button></div>
        {!detached ? <textarea className='theia-input' aria-label='View notes (Markdown)' value={text} rows={6}
            onChange={e => { latest.current = e.target.value; setText(e.target.value); }} onBlur={() => void save()} onKeyDown={e => e.stopPropagation()} /> : undefined}
        {error ? <div role='alert'>{error}</div> : undefined}
    </div>;
}

@injectable()
export class ViewNotesEditors implements FrontendApplicationContribution {
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(ViewEditors) protected readonly diagrams: ViewEditors;
    @inject(EditorManager) protected readonly editors: EditorManager;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    private readonly configured = new WeakSet<EditorWidget>();
    private readonly opening = new Set<string>();
    private readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;

    onStart(): void {
        for (const widget of this.shell.widgets) if (widget instanceof EditorWidget) this.configureEditor(widget);
        this.shell.onDidAddWidget(widget => {
            // The shell first attaches the native SaveableWidget behavior.
            if (widget instanceof EditorWidget) queueMicrotask(() => this.configureEditor(widget));
        });
    }

    private find(view: string): EditorWidget | undefined {
        return this.editors.all.find(w => w.editor.uri.scheme === VIEW_NOTES_SCHEME
            && notesTarget(w.editor.uri).file === this.model.snapshot.file && notesTarget(w.editor.uri).view === view);
    }

    has(view: string): boolean { return this.opening.has(view) || !!this.find(view); }

    private configureEditor(widget: EditorWidget): void {
        if (widget.editor.uri.scheme !== VIEW_NOTES_SCHEME || this.configured.has(widget) || !SaveableWidget.is(widget)) return;
        this.configured.add(widget);
        ensureMarkdown();
        widget.editor.setLanguage('markdown');
        widget.addClass('catenary-view-notes-editor');
        const target = notesTarget(widget.editor.uri);
        const focus = widget.editor.onFocusChanged(() => {
            if (widget.editor.isFocused() && this.model.snapshot.file === target.file) this.selection.set({ view: undefined, ids: [target.view] });
        });
        void this.model.service.properties(target.view).then(data => {
            if (!widget.isDisposed && data?.kind === 'view') widget.title.label = `${data.label} — Notes`;
        });
        const document = widget.editor.document;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let saving = 0;
        const clear = () => { clearTimeout(timer); timer = undefined; };
        const save = async () => {
            clear();
            if (!document.dirty && !saving) return;
            ++saving;
            try { await document.save({ saveReason: SaveReason.AfterDelay, formatType: FormatType.OFF }); }
            finally { --saving; }
        };
        const subscription = document.onContentChanged(() => {
            clear();
            // Schedule a new native save now if an older save is pending. Its cancellation token prevents
            // the older save from marking newer input clean. This includes undo back to the last saved text.
            if (saving) void save();
            else if (document.dirty) timer = setTimeout(() => void save(), 300);
        });
        // Closing the tab flushes the edit. A failed save leaves the native editor open and dirty.
        const close = widget.closeWithSaving.bind(widget);
        widget.closeWithSaving = async () => {
            await save();
            if (!document.dirty) await close({ shouldSave: () => true });
        };
        widget.close = () => { void widget.closeWithSaving(); };
        widget.disposed.connect(() => { clear(); subscription.dispose(); focus.dispose(); this.changed.fire(); });
        this.changed.fire();
    }

    async open(view: string): Promise<void> {
        const current = this.find(view);
        if (current) { await this.shell.activateWidget(current.id); return; }
        const file = this.model.snapshot.file;
        if (!file || this.opening.has(view)) return;
        this.opening.add(view);
        this.changed.fire();
        try {
            ensureMarkdown();
            const diagram = await this.diagrams.open(view);
            const widget = await this.editors.open(notesUri(file, view), {
                preview: false, widgetOptions: { area: 'main', mode: 'split-right', ref: diagram }
            });
            this.configureEditor(widget);
        } catch (error) {
            void this.messages.error(`Cannot open notes: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.opening.delete(view);
            this.changed.fire();
        }
    }
}
