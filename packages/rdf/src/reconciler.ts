// The reconciler: after a watch event, read again the files of the workspace that another program changed, and take out the files
// that it removed. The loader puts each read into the store (`FileStore`, given by the coordinator).

import { diskChanges, portableRelative } from 'rdf-files';
import { listModelFiles } from './files';
import { ModelGraph } from './graph';
import { FileRead, OnDisk, Saved, Settings } from './settings';

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
