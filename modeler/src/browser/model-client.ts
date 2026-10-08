// Frontend access to the model backend: the latest snapshot and edit commands.

import { Emitter, Event } from '@theia/core/lib/common/event';
import { MessageService } from '@theia/core/lib/common/message-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandResult, DEFAULT_PREFIXES, EditCommand, ModelSnapshot, baseName, dirName, relativePath, setPrefixes } from '@catenary/model';
import { ModelClient, ModelService } from '../common/protocol';

export const ModelServiceProxy = Symbol('ModelServiceProxy');

/** Receives snapshots from the backend. Bound as the RPC client object. */
@injectable()
export class ModelWatcher implements ModelClient {
    protected readonly emitter = new Emitter<ModelSnapshot>();
    readonly onSnapshot: Event<ModelSnapshot> = this.emitter.event;

    onDidChange(snapshot: ModelSnapshot): void {
        this.emitter.fire(snapshot);
    }
}

@injectable()
export class ModelFrontend {
    @inject(ModelServiceProxy) readonly service: ModelService;
    @inject(ModelWatcher) protected readonly watcher: ModelWatcher;
    @inject(MessageService) protected readonly messages: MessageService;

    snapshot: ModelSnapshot = {
        revision: -1, shapesVersion: -1, files: { files: [], views: [] }, meta: { classes: [] }, counts: { instances: 0, results: 0, violations: 0 }, warnings: [], migrations: [], movedIds: {}, prefixes: { table: { ...DEFAULT_PREFIXES }, stored: false }, dirty: false, canUndo: false, canRedo: false
    };

    /** Shapes as N-Triples, for the SHACL form. Undefined until read for the current `shapesVersion`. */
    shapesText?: string;
    protected shapesTextVersion = -1;

    protected readonly onDidChangeEmitter = new Emitter<ModelSnapshot>();
    /** Fires after each snapshot from the backend. */
    readonly onDidChange: Event<ModelSnapshot> = this.onDidChangeEmitter.event;
    protected ready?: Promise<void>;

    start(): Promise<void> {
        this.ready ??= (async () => {
            this.watcher.onSnapshot(s => this.accept(s));
            this.accept(await this.service.getSnapshot());
        })();
        return this.ready;
    }

    protected accept(s: ModelSnapshot): void {
        if (s.revision < this.snapshot.revision && s.file === this.snapshot.file) return;
        this.snapshot = s;
        // Compact IRIs and IRI fields of the frontend use the prefixes of the workspace.
        setPrefixes(s.prefixes.table);
        if (s.shapesVersion !== this.shapesTextVersion) this.readShapesText(s.shapesVersion);
        this.onDidChangeEmitter.fire(s);
    }

    protected async readShapesText(version: number): Promise<void> {
        this.shapesTextVersion = version;
        this.shapesText = undefined;
        const text = await this.service.shapesText();
        if (version !== this.snapshot.shapesVersion) return;
        this.shapesText = text;
        this.onDidChangeEmitter.fire(this.snapshot);
    }

    get meta() { return this.snapshot.meta; }
    get isOpen(): boolean { return !!this.snapshot.file; }

    /**
     * Run a command. Shows the error, if any, also an exception in the backend. A command that changes imported files asks to
     * mark them as own; after Mark as Own it runs again.
     */
    execute(command: EditCommand): Promise<CommandResult> {
        return this.withMarkOwn(command.kind, () => this.service.execute(command));
    }

    /** Undo or redo one step of the model, as `execute`: a step that changes imported files asks to mark them as own. */
    undo(): Promise<CommandResult> { return this.withMarkOwn('undo', () => this.service.undo()); }
    redo(): Promise<CommandResult> { return this.withMarkOwn('redo', () => this.service.redo()); }

    protected async withMarkOwn(name: string, call: () => Promise<CommandResult>): Promise<CommandResult> {
        const run = async (): Promise<CommandResult> => {
            try {
                return await call();
            } catch (e) {
                return { ok: false, error: `"${name}" failed in the backend: ${e instanceof Error ? e.message : String(e)}` };
            }
        };
        const r = await run();
        if (r.ok || !r.imported?.length) {
            if (!r.ok) this.messages.warn(r.error);
            return r;
        }
        if (!await this.askMarkOwn(r.imported)) return r;
        for (const file of r.imported) {
            const u = await this.service.setImported(file, false);
            if (!u.ok) {
                this.messages.warn(u.error);
                return u;
            }
        }
        const again = await run();
        if (!again.ok) this.messages.warn(again.error);
        return again;
    }

    /** The change needs protected files (absolute paths): ask to unprotect them. */
    protected async askMarkOwn(files: string[]): Promise<boolean> {
        const ws = this.snapshot.file;
        const names = files.map(f => (ws && relativePath(dirName(ws), f)) ?? baseName(f));
        const one = names.length === 1;
        // Loaded here: the browser module needs a DOM, and the unit tests of this module run in Node.
        const { ConfirmDialog } = await import('@theia/core/lib/browser');
        return !!await new ConfirmDialog({
            title: one ? 'Imported File' : 'Imported Files',
            msg: `This change edits ${one ? 'the imported file' : 'the imported files'} ${names.join(', ')}. Mark ${one ? 'it' : 'them'} as own and make the change?`,
            ok: 'Mark as Own', cancel: 'Cancel'
        }).open();
    }

    async report(p: Promise<CommandResult>): Promise<boolean> {
        const r = await p;
        if (!r.ok) this.messages.error(r.error);
        return r.ok;
    }

    // ---- read helpers

    /** The views (id and label), sorted by label. */
    async viewsSorted(): Promise<{ id: string; label: string }[]> {
        const labels = await this.service.viewLabels();
        return Object.entries(labels).map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
    }
}
