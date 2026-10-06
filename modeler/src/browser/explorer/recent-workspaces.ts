// Recently opened workspace files, newest first. Stored in the browser storage of the window (StorageService).

import { Emitter } from '@theia/core';
import { StorageService } from '@theia/core/lib/browser';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ModelFrontend } from '../model-client';

const KEY = 'catenary.recentWorkspaces';
const MAX = 10;

@injectable()
export class RecentWorkspaces {
    @inject(StorageService) protected readonly storage: StorageService;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    protected list: string[] = [];
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;
    /** Resolves when the list is read from storage. */
    ready: Promise<void>;

    get paths(): readonly string[] {
        return this.list;
    }

    @postConstruct()
    protected init(): void {
        this.ready = this.storage.getData<string[]>(KEY, []).then(list => {
            this.list = Array.isArray(list) ? list : [];
            this.onDidChangeEmitter.fire();
            this.add(this.model.snapshot.file);
        });
        this.model.onDidChange(() => this.add(this.model.snapshot.file));
    }

    protected add(file: string | undefined): void {
        if (!file || this.list[0] === file) return;
        this.list = [file, ...this.list.filter(f => f !== file)].slice(0, MAX);
        this.storage.setData(KEY, this.list);
        this.onDidChangeEmitter.fire();
    }
}
