// Virtual Markdown documents backed by the view graph, not separate .md files.
import { Emitter, Resource, ResourceResolver, ResourceSaveOptions } from '@theia/core';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ModelFrontend } from '../model-client';

export const VIEW_NOTES_SCHEME = 'catenary-view-notes';
export const notesUri = (file: string, view: string): URI => new URI(`${VIEW_NOTES_SCHEME}:/notes.md`).withQuery(encodeURIComponent(JSON.stringify({ file, view })));
export const notesTarget = (uri: URI): { file: string; view: string } => JSON.parse(decodeURIComponent(uri.query));

export class ViewNotesResource implements Resource {
    readonly encoding = 'utf8';
    // Notes have their own autosave policy. Do not change the user's source-file preferences.
    readonly autosaveable = false;
    version?: { text: string };
    private readonly changed = new Emitter<void>();
    readonly onDidChangeContents = this.changed.event;
    private readonly subscription;
    private saved?: string;
    private reading = 0;
    private writing = false;
    private disposed = false;
    private readonly target;

    constructor(readonly uri: URI, private readonly model: ModelFrontend) {
        this.target = notesTarget(uri);
        this.subscription = model.onDidChange(() => { if (!this.writing) void this.refresh(); });
    }

    private async read(): Promise<string> {
        if (this.model.snapshot.file !== this.target.file) throw new Error('The workspace changed. Your notes remain in the editor.');
        const data = await this.model.service.properties(this.target.view);
        if (data?.kind !== 'view') throw new Error('The view no longer exists. Your notes remain in the editor.');
        return data.description;
    }

    async readContents(): Promise<string> {
        const text = await this.read();
        this.saved = text;
        this.version = { text };
        return text;
    }

    private async refresh(): Promise<void> {
        const request = ++this.reading;
        const text = await this.read().catch(() => undefined);
        if (this.disposed || this.writing || request !== this.reading || text === undefined || text === this.saved) return;
        this.saved = text;
        this.changed.fire();
    }

    async saveContents(text: string, options?: ResourceSaveOptions): Promise<void> {
        if (this.model.snapshot.file !== this.target.file) throw new Error('The workspace changed. Your notes remain in the editor.');
        const expected = (options?.version as { text: string } | undefined)?.text ?? this.version?.text;
        this.writing = true;
        ++this.reading;
        try {
            const result = await this.model.execute({ kind: 'setViewDescription', view: this.target.view, text, expectedText: expected });
            if (!result.ok) throw new Error(result.error);
            this.saved = text;
            this.version = { text };
        } finally {
            this.writing = false;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.subscription.dispose();
        this.changed.dispose();
    }
}

@injectable()
export class ViewNotesResolver implements ResourceResolver {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;

    async resolve(uri: URI): Promise<Resource> {
        if (uri.scheme !== VIEW_NOTES_SCHEME) throw new Error('Not a view notes resource.');
        await this.model.start();
        return new ViewNotesResource(uri, this.model);
    }
}
