// RPC service for one frontend connection. Forwards store changes to the client, and each read query (MODEL_QUERIES) to the store.

import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandResult, EditCommand, ExportView, ImportResult, MODEL_QUERIES, ModelQueries, ModelSnapshot, Remote, idIri } from '@catenary/model';
import { MarkdownExportCheck, MarkdownExportResult, ModelClient, ModelService, WorkspaceSettings } from '../common/protocol';
import { checkOf, prepareMarkdownExport, writeMarkdownExport } from './markdown-export';
import { ModelStore } from '@catenary/rdf';

@injectable()
export class ModelServiceImpl implements ModelService, Disposable {
    @inject(ModelStore) protected readonly store: ModelStore;

    protected client?: ModelClient;
    protected readonly toDispose = new DisposableCollection();

    @postConstruct()
    protected init(): void {
        this.toDispose.push(this.store.onDidChange(() => this.client?.onDidChange(this.store.snapshot())));
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

    async getSnapshot(): Promise<ModelSnapshot> { return this.store.snapshot(); }
    open(workspacePath: string): Promise<CommandResult> { return this.store.open(workspacePath); }
    create(workspacePath: string, placement?: WorkspaceSettings['placement']): Promise<CommandResult> { return this.store.create(workspacePath, placement); }
    setPrefixes(prefixes: Record<string, string>): Promise<CommandResult> { return this.store.setPrefixes(prefixes); }
    setSettings(settings: WorkspaceSettings): Promise<CommandResult> { return this.store.setSettings(settings); }
    setImported(file: string, on: boolean): Promise<CommandResult> { return this.store.setImported(file, on); }
    importFiles(sources: string[]): Promise<ImportResult> { return this.store.importFiles(sources); }
    async checkMarkdownExport(source: string, destination: string): Promise<MarkdownExportCheck> {
        return checkOf(await prepareMarkdownExport(source, destination, this.views()));
    }
    async exportMarkdown(source: string, destination: string, svgs: Record<string, string>): Promise<MarkdownExportResult> {
        const prepared = await prepareMarkdownExport(source, destination, this.views());
        if ('error' in prepared) return { ok: false, error: prepared.error, written: [], unchanged: [], removed: [], kept: [], conflicts: [], problems: [] };
        return writeMarkdownExport(prepared, svgs);
    }
    async dismissMigration(id: string): Promise<void> { this.store.dismissMigration(id); }
    save(): Promise<CommandResult> { return this.store.save(); }
    async undo(): Promise<CommandResult> { return this.store.undo(); }
    async redo(): Promise<CommandResult> { return this.store.redo(); }
    async execute(command: EditCommand): Promise<CommandResult> { return this.store.execute(command); }

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
                    return Promise.resolve((this.store[name] as (...a: unknown[]) => unknown).apply(this.store, args));
                },
                writable: true,
                configurable: true
            });
        }
    }
}

export interface ModelServiceImpl extends Remote<ModelQueries> {}
