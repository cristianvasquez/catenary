// Files on disk as the source of truth: one file operation at a time, a watch of a folder, the changes that another program made,
// and writes of several files that succeed or fail together.

import { createHash } from 'crypto';
import { FSWatcher, promises as fs, statSync, watch } from 'fs';
import * as path from 'path';

/** Run async operations one at a time, in the order of the calls. A failure does not stop the next operation. */
export class SerialQueue {
    protected tail: Promise<unknown> = Promise.resolve();

    run<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.tail.then(fn, fn);
        this.tail = next.catch(() => undefined);
        return next;
    }

    /** Resolves when the queued operations are done. */
    idle(): Promise<void> {
        return this.tail.then(() => undefined);
    }
}

/** A path with a hidden part (`.git`, a temporary file of `writeAll`). */
export const isHidden = (name: string) => name.split(/[\\/]/).some(part => part.startsWith('.'));

export interface WatchOptions {
    /** Time without events before `onSettled`, in ms. Default: 150 (an editor writes a file in more than one step). */
    debounce?: number;
    /** Events of these names (relative to the folder) are ignored. Default: `isHidden`. */
    ignore?: (name: string) => boolean;
}

/**
 * A recursive watch of one folder. `onSettled` runs after `debounce` ms without events, with the absolute paths of the events since the
 * last call. `changed` is undefined when an event had no file name (the platform did not give one). The watch does not keep the process alive.
 */
export class FolderWatcher {
    protected watcher?: FSWatcher;
    protected timer?: ReturnType<typeof setTimeout>;
    protected watched?: string;
    /** Paths of the events since the last `onSettled`. Undefined: an event without a name. */
    protected changed?: Set<string> = new Set();

    constructor(protected readonly onSettled: (changed?: string[]) => void, protected readonly options: WatchOptions = {}) {}

    /** The watched folder. */
    get folder(): string | undefined {
        return this.watched;
    }

    /** Watch `folder` (and stop the watch of another folder). A folder that is not on disk: no watch; the next call tries again. */
    watch(folder: string): void {
        if (folder === this.watched) return;
        this.close();
        const ignore = this.options.ignore ?? isHidden;
        const onEvent = (_event: string, name: string | Buffer | null) => {
            if (name && ignore(String(name))) return;
            if (!name) this.changed = undefined;
            else this.changed?.add(path.join(folder, String(name)));
            clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                const changed = this.changed && [...this.changed];
                this.changed = new Set();
                this.onSettled(changed);
            }, this.options.debounce ?? 150);
            this.timer.unref?.();
        };
        // A recursive watch of a missing folder does not throw on every platform: check first.
        if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) return;
        try {
            const w = watch(folder, { recursive: true, persistent: false }, onEvent);
            // An error event without a listener stops the process. After an error (the folder was removed), the next call tries again.
            w.on('error', () => { if (this.watcher === w) this.close(); });
            this.watcher = w;
            this.watched = folder;
        } catch {
            // no watch: the next call tries again
        }
    }

    close(): void {
        this.watcher?.close();
        this.watcher = undefined;
        this.watched = undefined;
        this.changed = new Set();
        clearTimeout(this.timer);
    }
}

/**
 * The files that this program wrote or removed, with the text that it wrote (a hash). A watch event of such a file is the program's own
 * write while the file has that text: the program need not read the file again. The content is compared, not the size and the time:
 * another program can write other text with the same size and time (a coarse file system clock, a tool that keeps the time).
 */
export class OwnWrites {
    protected readonly files = new Map<string, string>();

    /** Record what this program wrote to `file`: its text, or undefined for a removal. */
    note(file: string, text: string | undefined): void {
        this.files.set(path.resolve(file), digest(text));
    }

    /** `file` has the text that `note` recorded (or is still absent after a noted removal). Reads only this file. */
    async isOwn(file: string): Promise<boolean> {
        const own = this.files.get(path.resolve(file));
        return own !== undefined && own === digest(await readText(file));
    }

    clear(): void {
        this.files.clear();
    }
}

const digest = (text: string | undefined): string => text === undefined ? 'absent' : createHash('sha256').update(text).digest('hex');

/** The text of a file, or undefined when it cannot be read (not on disk). */
export const readText = (file: string): Promise<string | undefined> => fs.readFile(file, 'utf8').catch(() => undefined);

/** A file that the program knows: the text that it last read or wrote. */
export interface Tracked {
    path: string;
    /** Undefined: no text is known (the read failed, or the file is not on disk yet). */
    text?: string;
    /** With no `text`: the file is not on disk yet, so its absence is not a removal. Ignored when `text` is set. */
    unwritten?: boolean;
}

/**
 * What another program changed. `removed`: tracked files that are not in `members`, except files with no `text` that are `unwritten`. `read`: the files of `members`
 * to read again, in the order of `members`: a tracked file whose text on disk is not its known text (`known`), or a new file.
 */
export async function diskChanges(tracked: Iterable<Tracked>, members: Iterable<string>): Promise<{ removed: string[]; read: { path: string; known: boolean }[] }> {
    const known = new Map([...tracked].map(f => [f.path, f]));
    const now = new Set(members);
    const removed = [...known.values()].filter(f => !(f.text === undefined && f.unwritten) && !now.has(f.path)).map(f => f.path);
    const read: { path: string; known: boolean }[] = [];
    for (const file of now) {
        const f = known.get(file);
        if (f) {
            const t = await readText(file);
            if (t === undefined || t === f.text) continue;
        }
        read.push({ path: file, known: !!f });
    }
    return { removed, read };
}

/** The text of a file before a write: undefined when it is not on disk. An error when it is not `last` (another program changed it). */
export async function readUnchanged(file: string, last: string | undefined): Promise<string | undefined> {
    const disk = await readText(file);
    if (disk !== undefined && last !== undefined && disk !== last) {
        throw new Error(`${path.basename(file)} changed on disk since it was read; not written. Reload it first.`);
    }
    return disk;
}

/** The name of the temporary file of `file`: hidden, next to it (the same file system, so that a rename replaces the file). */
export const tmpPath = (file: string, suffix = '.tmp') => path.join(path.dirname(file), `.${path.basename(file)}${suffix}`);

/**
 * Write several files: each text to a temporary file first, then a rename of each. `renamed` runs after the rename of each write.
 * Returns an error text, else undefined. When a temporary file cannot be written, no file changes (the temporary files are removed).
 * When a rename fails, the files renamed before it stay written, and the remaining temporary files are removed.
 */
export async function writeAll<W extends { file: string; text: string }>(writes: W[], renamed: (w: W) => void = () => undefined, tmpSuffix?: string): Promise<string | undefined> {
    const tmp = (file: string) => tmpPath(file, tmpSuffix);
    try {
        for (const { file, text } of writes) {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(tmp(file), text);
        }
    } catch (e) {
        // A cleanup failure (for example ENOTDIR) must not hide the write error.
        await Promise.all(writes.map(({ file }) => fs.rm(tmp(file), { force: true }).catch(() => undefined)));
        return `Cannot write: ${(e as Error).message}`;
    }
    for (const [i, w] of writes.entries()) {
        try {
            await fs.rename(tmp(w.file), w.file);
        } catch (e) {
            await Promise.all(writes.slice(i).map(({ file }) => fs.rm(tmp(file), { force: true }).catch(() => undefined)));
            return `Cannot write ${path.basename(w.file)}: ${(e as Error).message}`;
        }
        renamed(w);
    }
    return undefined;
}
