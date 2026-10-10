// RPC service for one frontend connection. Forwards store changes to the client, and each read query (MODEL_QUERIES) to the store.

import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandResult, EditCommand, ExportView, ImportResult, MODEL_QUERIES, ModelQueries, ModelSnapshot, Remote, TraceBatch, idIri } from '@catenary/model';
import { MarkdownExportCheck, MarkdownExportResult, ModelClient, ModelService, WorkspaceSettings } from '../common/protocol';
import { checkOf, prepareMarkdownExport, writeMarkdownExport } from './markdown-export';
import { ModelStore, tracer } from '@catenary/rdf';

@injectable()
export class ModelServiceImpl implements ModelService, Disposable {
    @inject(ModelStore) protected readonly store: ModelStore;

    protected client?: ModelClient;
    protected readonly toDispose = new DisposableCollection();
    /** This connection has the trace on (setTracing). */
    protected tracing = false;

    @postConstruct()
    protected init(): void {
        this.toDispose.push(this.store.onDidChange(() => {
            if (!this.client) return;
            if (!tracer.on) return this.client.onDidChange(this.store.snapshot());
            tracer.span('snapshot', 'to client', () => {
                const s = this.store.snapshot();
                tracer.note(undefined, JSON.stringify(s).length);
                this.client!.onDidChange(s);
            });
        }));
        this.toDispose.push(Disposable.create(() => this.setTracing(false)));
    }

    setClient(client: ModelClient | undefined): void {
        this.client = client;
    }

    getClient(): ModelClient | undefined {
        return this.client;
    }

    dispose(): void {
        this.toDispose.dispose();
    }

    async getSnapshot(): Promise<ModelSnapshot> { return tracer.span('rpc', 'getSnapshot', () => this.store.snapshot()); }
    open(workspacePath: string): Promise<CommandResult> { return tracer.span('rpc', 'open', () => this.store.open(workspacePath)); }
    create(workspacePath: string, placement?: WorkspaceSettings['placement']): Promise<CommandResult> { return tracer.span('rpc', 'create', () => this.store.create(workspacePath, placement)); }
    setPrefixes(prefixes: Record<string, string>): Promise<CommandResult> { return tracer.span('rpc', 'setPrefixes', () => this.store.setPrefixes(prefixes)); }
    setSettings(settings: WorkspaceSettings): Promise<CommandResult> { return tracer.span('rpc', 'setSettings', () => this.store.setSettings(settings)); }
    setImported(file: string, on: boolean): Promise<CommandResult> { return tracer.span('rpc', 'setImported', () => this.store.setImported(file, on)); }
    importFiles(sources: string[]): Promise<ImportResult> { return tracer.span('rpc', 'importFiles', () => this.store.importFiles(sources)); }
    async checkMarkdownExport(source: string, destination: string): Promise<MarkdownExportCheck> {
        return tracer.span('rpc', 'checkMarkdownExport', async () => checkOf(await prepareMarkdownExport(source, destination, this.views())));
    }
    async exportMarkdown(source: string, destination: string, svgs: Record<string, string>): Promise<MarkdownExportResult> {
        return tracer.span('rpc', 'exportMarkdown', async () => {
            const prepared = await prepareMarkdownExport(source, destination, this.views());
            if ('error' in prepared) return { ok: false, error: prepared.error, written: [], unchanged: [], removed: [], kept: [], conflicts: [], problems: [] };
            return writeMarkdownExport(prepared, svgs);
        });
    }
    async dismissMigration(id: string): Promise<void> { tracer.span('rpc', 'dismissMigration', () => this.store.dismissMigration(id)); }
    save(): Promise<CommandResult> { return tracer.span('rpc', 'save', () => this.store.save()); }
    async undo(): Promise<CommandResult> { return tracer.span('rpc', 'undo', () => this.store.undo()); }
    async redo(): Promise<CommandResult> { return tracer.span('rpc', 'redo', () => this.store.redo()); }
    async execute(command: EditCommand): Promise<CommandResult> { return tracer.span('rpc', 'execute', () => this.store.execute(command)); }

    async setTracing(on: boolean): Promise<void> {
        if (on === this.tracing) return;
        this.tracing = on;
        tracer.setClient(on);
    }
    async trace(since: number): Promise<TraceBatch> { return tracer.take(since); }
    async stopTracing(since: number): Promise<TraceBatch> {
        const batch = tracer.take(since);
        // Capture before releasing this connection. The last release clears the shared trace.
        await this.setTracing(false);
        return batch;
    }
    async clearTrace(): Promise<void> { tracer.clear(); }

    /** The views of the model by IRI. A view id is the encoded IRI (@catenary/model iriId): the IRI is the identity in a document. */
    protected views(): Map<string, ExportView> {
        const views = new Map<string, ExportView>();
        for (const [id, label] of Object.entries(this.store.viewLabels())) {
            const iri = idIri(id);
            if (iri) views.set(iri, { id, label });
        }
        return views;
    }

    // The read queries: methods of the prototype, so that the RPC proxy and the CLI call them by name.
    static {
        for (const name of Object.keys(MODEL_QUERIES) as (keyof ModelQueries)[]) {
            Object.defineProperty(ModelServiceImpl.prototype, name, {
                value(this: ModelServiceImpl, ...args: unknown[]) {
                    return Promise.resolve(tracer.span('rpc', name, () => (this.store[name] as (...a: unknown[]) => unknown).apply(this.store, args)));
                },
                writable: true,
                configurable: true
            });
        }
    }
}

export interface ModelServiceImpl extends Remote<ModelQueries> {}
