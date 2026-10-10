// The reconciler: after a watch event, read again the files of the workspace that another program changed, and take out the files
// that it removed. The loader puts each read into the store (`FileStore`, given by the coordinator).

import { FolderWatcher, OwnWrites, SerialQueue, diskChanges, portableRelative, readText as readDisk } from 'rdf-files';
import * as path from 'path';
import { tracer } from './trace';
import { listModelFiles } from './files';
import { ModelGraph } from './graph';
import { FileRead, OnDisk, Saved, Settings } from './settings';

/** The coordinator supplies current modules and handles the read outcomes. */
export interface ReconcilerPort {
    settings(): Settings | undefined;
    graph(): ModelGraph;
    files(): FileStore;
    saved(): Saved;
    ownWrites(): OwnWrites | undefined;
    queue: SerialQueue;
    syncFromDisk(): Promise<string[]>;
    gone(settings: Settings): void;
    reopen(file: string): Promise<void>;
    forget(): void;
    filesRead(read: string[], notes: string[], unmounted: Set<string>, settings: Settings): Promise<void>;
    nothingRead(): void;
}

/** Watch events run after the writes that caused them, in the shared file queue. */
export class Reconciler {
    protected readonly watcher = new FolderWatcher(changed => void this.port.queue.run(() => this.syncFromWatch(changed)));

    constructor(protected readonly port: ReconcilerPort) {}

    watch(folder: string): void { this.watcher.watch(folder); }
    close(): void { this.watcher.close(); }

    /** Skip events whose files still hold Catenary's own writes. */
    protected async syncFromWatch(changed?: string[]): Promise<void> {
        const own = this.port.ownWrites();
        if (own && changed?.length && (await Promise.all(changed.map(f => own.isOwn(f)))).every(Boolean)) {
            tracer.root('file', 'own write: not read again', () => tracer.note(changed.map(f => path.basename(f)).join(', ')));
            return;
        }
        await tracer.root('file', 'read changed files', () => this.port.syncFromDisk());
    }

    /** A changed workspace reopens. Otherwise read the changed model files. */
    async syncFromDisk(): Promise<string[]> {
        const ws = this.port.settings();
        if (!ws) return [];
        const text = await readDisk(ws.path);
        if (text === undefined && ws.workspace.text !== undefined) {
            this.port.gone(ws);
            return [];
        }
        // Also a workspace file that another program made (the folder was opened without one).
        if (text !== undefined && text !== ws.workspace.text) {
            const name = path.basename(ws.path);
            await this.port.reopen(ws.path);
            return [name];
        }
        const { read, notes, unmounted } = await readChanges(this.port.graph(), ws, this.port.files(), this.port.saved());
        this.port.forget();
        if (!read.length && !notes.length) {
            this.port.nothingRead();
            return [];
        }
        await this.port.filesRead(read, notes, unmounted, ws);
        return read;
    }
}

/** What the reconciler needs of the loader. */
export interface FileStore {
    read(file: string): Promise<FileRead>;
    mount(r: FileRead, notes: string[]): boolean;
    unmount(file: string): void;
}

/**
 * Read again the model files that another program changed (the text on disk is not the text that Catenary last read or wrote), and
 * the files that are new or removed in the folder. `read`: the names of the files read or removed; `unmounted`: the names of the
 * files taken out of the store. `pending`: what differs from the files (saver.ts): a file read again loses these changes.
 */
export async function readChanges(graph: ModelGraph, settings: Settings, files: FileStore, pending: Saved): Promise<{ read: string[]; notes: string[]; unmounted: Set<string> }> {
    const members = new Set(await listModelFiles(settings.workspace.path, settings.exclude));
    const known = new Map<string, OnDisk & { path: string; error?: string }>([...settings.modelFiles.values(), ...settings.viewFiles.values()].map(f => [f.path, f]));
    const read: string[] = [], notes: string[] = [];
    const name = (file: string) => portableRelative(settings.folder, file);
    // The "not read" warnings of these files are replaced: the file is gone, or read again (a new failure gives a new warning).
    const unmounted = new Set<string>();
    // A file without text and without a read error is not written yet: not a removal.
    const changes = await diskChanges([...known.values()].map(f => ({ path: f.path, text: f.text, unwritten: f.error === undefined })), members);
    const reads = await Promise.all(changes.read.map(async ({ path: file, known: f }) => ({ file, f, r: await files.read(file) })));
    graph.update(() => {
        for (const file of changes.removed) {
            const f = known.get(file)!;
            files.unmount(file);
            unmounted.add(name(file));
            read.push(name(file));
            notes.push(f.error === undefined ? `${name(file)} was removed on disk: its statements are removed.` : `${name(file)} was removed on disk.`);
        }
        for (const { file, f, r } of reads) {
            const lost = f && (pending.files.has(file) || [...settings.viewFiles].some(([v, x]) => x.path === file && pending.views.has(v)));
            files.unmount(file);
            unmounted.add(name(file));
            if (typeof r === 'string') { notes.push(r); continue; }
            if (!files.mount(r, notes)) continue;
            read.push(name(file));
            notes.push(f ? `${name(file)} changed on disk: read again${lost ? '; its changes that were not written are lost' : ''}.` : `${name(file)} is new on disk: read.`);
        }
        settings.syncShapesTarget();
    });
    return { read, notes, unmounted };
}
