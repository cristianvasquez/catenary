// RPC service for one frontend connection. Forwards store changes to the client, and each read query (MODEL_QUERIES) to the store.

import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandResult, EditCommand, ImportResult, MODEL_QUERIES, ModelQueries, ModelSnapshot, Remote } from '@catenary/model';
import { ModelClient, ModelService, WorkspaceSettings } from '../common/protocol';
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
    setProtected(file: string, on: boolean): Promise<CommandResult> { return this.store.setProtected(file, on); }
    importFile(source: string): Promise<ImportResult> { return this.store.importFile(source); }
    setExportViews(ids: string[]): Promise<CommandResult> { return this.store.setExportViews(ids); }
    async dismissMigration(id: string): Promise<void> { this.store.dismissMigration(id); }
    save(): Promise<CommandResult> { return this.store.save(); }
    async undo(): Promise<CommandResult> { return this.store.undo(); }
    async redo(): Promise<CommandResult> { return this.store.redo(); }
    async execute(command: EditCommand): Promise<CommandResult> { return this.store.execute(command); }

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
