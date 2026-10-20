// The saver (ADR 0003): what differs from the files on disk, and the save. A save writes each changed file (Turtle that Catenary read
// or wrote: a patch of its text, text-patch.ts), all or none, and records the written paths for the commit (Writer.commit). The canonical form of each
// file is cached and computed again only for the files that a change touched.

import { CommandResult, PREFIXES, compareLabels, localName } from '@catenary/model';
import type { NamedNode, Quad } from '@rdfjs/types';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { OwnWrites, SerialQueue, StatementDiff, commitFiles, gitChanges, parseTurtleText, patchTurtle, patchTurtleDiff, pathKey, portableRelative, readUnchanged, termKey, tripleKey, writeAll } from 'rdf-files';
import type { Change } from './graph';
import { elementId } from './ids';
import { IMPORT_FOLDER, manifestQuads, parseRdf, serializeRdf, writeProblem } from './files';
import { ModelGraph, dataGraphIri, shapesGraphIri, fileOfGraph } from './graph';
import { OnDisk, Saved, Settings } from './settings';
import { rdf } from './terms';
import { canonical, writeTrig } from './trig';
import { skolemize } from 'rdf-core';
import { tracer } from './trace';
import { views } from './views';

/** The coordinator supplies the current workspace and the shared file queue. */
export interface WriterPort {
    saver(): Saver | undefined;
    writable(): boolean;
    queue: SerialQueue;
    warnings: string[];
    saved(): void;
    /** The label of each view of the graph (view id -> label, view-read.ts viewLabels). */
    viewLabels(): Record<string, string>;
}

/** What the next commit contains (manifest §10.3): command kinds with counts, the IRIs of the views touched, all edits layout-only. */
export interface PendingCommit { kinds: Map<string, number>; views: Set<string>; layout: boolean }

const emptyPending = (): PendingCommit => ({ kinds: new Map(), views: new Set(), layout: true });

/**
 * The commit message (manifest §10.3 commitMessage): the kinds by count (descending), then by name, `kind ×N` for a count above 1, at
 * most 5 then `…`; then up to 3 view labels, sorted, in parentheses. `label`: the label of a view IRI.
 */
export function commitMessage(pending: PendingCommit, label: (view: string) => string): string {
    const kinds = [...pending.kinds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, n]) => n === 1 ? k : `${k} ×${n}`);
    const views = [...pending.views].map(label).sort(compareLabels);
    return `Catenary: ${kinds.slice(0, 5).join(', ')}${kinds.length > 5 ? ', …' : ''}${views.length ? ` (${views.slice(0, 3).join(', ')}${views.length > 3 ? ', …' : ''})` : ''}`;
}

/** Write batches and the pending commit live across workspace opens. A write does not commit: a commit runs after `commitDelay` ms without content edits, or at `commit()`. */
export class Writer {
    protected writeQueued = false;
    /** What the next commit contains. */
    pending = emptyPending();
    /** The last write or commit error; it shows in the warnings until that step succeeds. */
    writeError?: string;
    /** The step that gave `writeError`: a write that succeeds does not clear a commit error. */
    protected errorOf?: 'write' | 'commit';
    protected timer?: ReturnType<typeof setTimeout>;
    readonly commitDelay: number;

    constructor(protected readonly port: WriterPort, options: { commitDelay?: number } = {}) {
        this.commitDelay = options.commitDelay ?? 60000;
    }

    /**
     * Add to the next commit: command kinds (undo, redo, files, …), the IRIs of the views touched. A content edit (`layoutOnly` not
     * true) starts the commit timer again (law_layoutDoesNotStartCommitTimer).
     */
    note(kinds: string[], views: string[] = [], layoutOnly = false): void {
        for (const k of kinds) this.pending.kinds.set(k, (this.pending.kinds.get(k) ?? 0) + 1);
        for (const v of views) this.pending.views.add(v);
        this.pending.layout &&= layoutOnly;
        if (layoutOnly) return;
        this.stopTimer();
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.port.queue.run(() => this.commit());
        }, this.commitDelay);
        this.timer.unref?.();
    }

    /** Stop the commit timer (dispose, open). */
    stopTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    /** Queue one write for all changes that come before it runs. */
    queueWrite(): void {
        if (!this.port.writable() || this.writeQueued) return;
        this.writeQueued = true;
        void this.port.queue.run(async () => {
            this.writeQueued = false;
            await tracer.span('file', 'write', () => this.write());
        });
    }

    /** Write the changed files (law_writeDoesNotCommit). Keep a failure visible until success. */
    async write(): Promise<CommandResult> {
        const ws = this.port.saver();
        const warningCount = this.port.warnings.length;
        const r: CommandResult = ws ? await tracer.span('file', 'save', () => ws.save()) : { ok: false, error: 'No workspace is open.' };
        // A write does not change the dataset: the caches stay (only the dirty state changes).
        if (r.ok) {
            this.port.saved();
            ws!.written = [...new Set(ws!.written)];
        }
        this.report(r.ok ? undefined : `Not written: ${r.error}`, 'write', warningCount);
        return r;
    }

    /**
     * Commit the written files with the message of the pending record, then clear the record and the paths. Auto-commit off, or no
     * repository: no commit, the paths stay (a later read from disk does not take Catenary's writes for changes of the user, and a
     * commit after auto-commit is turned on includes them). A failed commit keeps the record and the paths for the next commit.
     */
    async commit(): Promise<void> {
        this.stopTimer();
        const ws = this.port.saver();
        if (!ws || !this.pending.kinds.size) return;
        const warningCount = this.port.warnings.length;
        // Notes of edits during the commit go to a new record.
        const pending = this.pending;
        this.pending = emptyPending();
        const files = ws.committable();
        // Auto-commit off: nothing to keep. Nothing to commit yet (a failed write): the record waits for the files.
        if (!files.length) {
            if (ws.commits) this.restore(pending);
            return;
        }
        const labels = this.port.viewLabels();
        const message = commitMessage(pending, v => labels[elementId(rdf.namedNode(v))] ?? localName(v));
        const error = await tracer.span('file', 'commit', () => commitFiles(files, message));
        if (error) this.restore(pending);
        else ws.written = [];
        this.report(error, 'commit', warningCount);
    }

    /** Put a record back before the notes that came after it. */
    protected restore(pending: PendingCommit): void {
        for (const [k, n] of this.pending.kinds) pending.kinds.set(k, (pending.kinds.get(k) ?? 0) + n);
        for (const v of this.pending.views) pending.views.add(v);
        pending.layout &&= this.pending.layout;
        this.pending = pending;
    }

    /** Show the error of a write or a commit in the warnings, in place of the last one. */
    protected report(error: string | undefined, step: 'write' | 'commit', warningCount: number): void {
        if (!error && this.writeError && this.errorOf !== step) error = this.writeError;
        else this.errorOf = error ? step : undefined;
        if (error !== this.writeError || this.port.warnings.length !== warningCount) {
            this.port.warnings = [...this.port.warnings.filter(w => w !== this.writeError), ...(error ? [error] : [])];
            this.writeError = error;
            this.port.saved();
        }
    }
}

/** Import copies: choose names first, then write them, or remove them on failure. */
export class ImportCopies<T extends { name: string; quads?: Quad[] }> {
    readonly targets = new Map<T, string>();
    protected readonly folder: string;

    constructor(folder: string, copies: T[]) {
        this.folder = path.join(folder, IMPORT_FOLDER);
        for (const r of copies) {
            const base = r.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'imported';
            let target = path.join(this.folder, `${base}.ttl`);
            for (let i = 2; existsSync(target) || [...this.targets.values()].includes(target); i++) target = path.join(this.folder, `${base}-${i}.ttl`);
            this.targets.set(r, target);
        }
    }

    async write(): Promise<void> {
        await fs.mkdir(this.folder, { recursive: true });
        for (const [r, target] of this.targets) {
            // The default graph: a model file has no graph names.
            const triples = skolemize(r.quads!.map(q => rdf.quad(q.subject, q.predicate, q.object))).quads;
            await fs.writeFile(target, await serializeRdf(triples, target), { flag: 'wx' });
        }
    }

    async undo(): Promise<void> {
        for (const t of this.targets.values()) await fs.rm(t, { force: true });
    }
}

interface Canonical { workspace: string; files: Map<string, string>; views: Map<string, string> }

/** The net changes of the statements of a view since its last write: a statement added and removed again is not a change. */
class NetDiff {
    readonly removed = new Map<string, Quad>();
    readonly added = new Map<string, Quad>();
    apply(op: Change['op'], q: Quad): void {
        const k = tripleKey(q), [from, to] = op === 'add' ? [this.removed, this.added] : [this.added, this.removed];
        if (!from.delete(k)) to.set(k, q);
    }
    /** These changes, then `later`. */
    then(later: NetDiff): NetDiff {
        for (const q of later.removed.values()) this.apply('remove', q);
        for (const q of later.added.values()) this.apply('add', q);
        return this;
    }
}

const EMPTY = canonical([]);

const toTriple = (q: Quad) => rdf.quad(q.subject, q.predicate, q.object);

export class Saver {
    /** Written or removed paths awaiting a successful commit. */
    written: string[] = [];
    /** The text of each write and each removal of this workspace: their watch events are not changes on disk. */
    readonly ownWrites = new OwnWrites();
    /** pathKey of each file with changes in git that Catenary did not write. */
    protected uncommitted = new Set<string>();
    /** The workspace folder is in a git repository (recordUncommitted). */
    repo = false;
    /** A write is committed: auto-commit is on and the workspace folder is in a repository. */
    get commits(): boolean { return this.settings.autoCommit && this.repo; }
    protected cache?: { event: unknown; canonical: Canonical };
    /**
     * The entries of `cache` that a change made out of date: `f:<path>` a model file, `v:<view IRI>` a view. 'all': every entry. Each
     * change of the store marks its graphs, so that the next save computes the canonical form of the files it touched only.
     */
    protected stale: Set<string> | 'all' = 'all';
    /** The net changes of each view (IRI) since its last write, from that write on: the text patch of the view file reads only their blocks. */
    protected pending = new Map<string, NetDiff>();

    constructor(protected readonly graph: ModelGraph, protected readonly settings: Settings, protected readonly note: (text: string) => void) {
        graph.onDidChange(event => {
            this.touch(event.patch.map(c => c.quad));
            for (const c of event.patch) if (!this.graph.isDataGraph(c.quad.graph) && !this.graph.isShapesGraph(c.quad.graph)) this.pending.get(c.quad.graph.value)?.apply(c.op, toTriple(c.quad));
        });
    }

    /** Compute every file again at the next `current` (after a read of files). */
    forget(): void {
        this.stale = 'all';
        this.pending.clear();
    }

    /** A file differs from the saved one. */
    get dirty(): boolean {
        const s = this.savedState();
        return s.workspace || s.files.size > 0 || s.views.size > 0 || s.deleted.length > 0;
    }

    /** Which files differ from the saved ones. `views`: view graphs not saved; `deleted`: files of deleted views, still on disk. */
    savedState(): Saved {
        const now = this.current(), s = this.settings;
        return {
            workspace: now.workspace !== s.workspace.saved,
            files: new Set([...s.modelFiles.values()].filter(f => !f.error && now.files.get(f.path) !== (f.saved ?? EMPTY)).map(f => f.path)),
            views: new Set([...now.views].filter(([v, text]) => s.viewFiles.get(v)?.saved !== text).map(([v]) => v)),
            deleted: [...s.viewFiles].filter(([v, f]) => !now.views.has(v) && f.saved !== undefined).map(([v]) => v)
        };
    }

    /** Write the changed files (all or none, see `writeAll`). The caller commits `written`. */
    async save(): Promise<CommandResult> {
        const s = this.settings, saved = tracer.span('file', 'saved state', () => this.savedState());
        const problem = [...saved.files].map(f => writeProblem(f)).find(p => !!p);
        if (problem) return { ok: false, error: `${problem}. Convert the file to Turtle first.` };
        const kept = [...saved.files, ...[...saved.views].map(v => s.viewFiles.get(v)?.path)].map(f => f && s.readOnlyContentReason(f)).find(p => !!p);
        if (kept) return { ok: false, error: kept };
        // Read the content now: edits during the writes do not count as saved.
        const now = this.current();
        type Write = { file: string; text: string; done: () => void };
        const writes: Write[] = [];
        // The pending changes of the views of this save: the changes that come later go to a new diff. A failed save puts them back.
        const taken = new Map<string, NetDiff>();
        const failed = (error: string): CommandResult => {
            for (const [v, diff] of taken) this.pending.set(v, diff.then(this.pending.get(v)!));
            return { ok: false, error };
        };
        // A file is written when it changed. `graph`: a view file, written as TriG with one graph (the view).
        const onDisk = async (f: OnDisk & { path: string; saved?: string }, changed: boolean, triples: () => Quad[], content: string, graph?: NamedNode) => {
            if (!changed) return;
            const all = triples();
            let diff: StatementDiff | undefined;
            if (graph) {
                const net = this.pending.get(graph.value);
                if (net) {
                    taken.set(graph.value, net);
                    this.pending.set(graph.value, new NetDiff());
                    // The statements of this save (`all`), not the live store: an edit during the disk read is not in `content`.
                    const bySubject = (quads: Quad[]) => { const m = new Map<string, Quad[]>(); for (const q of quads) (m.get(termKey(q.subject)) ?? m.set(termKey(q.subject), []).get(termKey(q.subject))!).push(q); return m; };
                    let after: Map<string, Quad[]> | undefined, before: Map<string, Quad[]> | undefined;
                    diff = { removed: [...net.removed.values()], added: [...net.added.values()],
                        after: subject => (after ??= bySubject(all)).get(termKey(subject)) ?? [],
                        had: subject => ((before ??= bySubject(f.triples ?? [])).get(termKey(subject))?.length ?? 0) > 0 };
                }
            }
            const text = await this.fileText(f, all, content, graph, diff);
            writes.push({ file: f.path, text, done: () => {
                Object.assign(f, { saved: content, text, triples: all, blanks: 0 });
                // From this write on, the changes of the view are known.
                if (graph) { taken.delete(graph.value); if (!this.pending.has(graph.value)) this.pending.set(graph.value, new NetDiff()); }
            } });
        };
        try {
            for (const f of s.modelFiles.values()) if (!f.error) await onDisk(f, saved.files.has(f.path), () => this.filesTriples([f.path]).get(f.path)!, now.files.get(f.path)!);
            for (const v of views(this.graph)) {
                const f = s.viewFiles.get(v.value);
                if (f) await onDisk(f, saved.views.has(v.value), () => this.viewTriples(v), now.views.get(v.value)!, v);
            }
        } catch (e) {
            return failed((e as Error).message);
        }
        const w = s.workspace;
        if (saved.workspace) {
            const text = await writeTrig(manifestQuads(s.manifest(), w.path));
            writes.push({ file: w.path, text, done: () => Object.assign(w, { saved: now.workspace, text }) });
        }
        if (s.retired) return failed('Another workspace was opened during the save.');
        // All files or none: temporary files first, then a rename of each.
        const error = writes.length ? await tracer.span('file', 'write files', () => writeAll(writes, ({ file, text, done }) => {
            this.ownWrites.note(file, text);
            this.written.push(file);
            done();
        }, '.catenary-tmp')) : undefined;
        if (error) return failed(error);
        for (const v of saved.deleted) {
            const f = s.viewFiles.get(v)!;
            try {
                await fs.rm(f.path, { force: true });
                this.ownWrites.note(f.path, undefined);
            } catch (e) {
                return { ok: false, error: `Cannot remove ${f.path}: ${(e as Error).message}` };
            }
            this.written.push(f.path);
            s.viewFiles.delete(v);
        }
        return { ok: true };
    }

    /**
     * The files with changes in git that Catenary did not write (at open, and for the files read again by the watcher): their writes
     * are not committed, so that a commit never takes changes of the user. Outside a repository: no commit and no warning.
     */
    async recordUncommitted(reloaded: string[] = []): Promise<void> {
        const changes = await gitChanges(this.settings.folder);
        this.repo = changes.ok || changes.repo;
        if (!this.repo) return;
        // No status (for example a locked or damaged index): no auto-commit at all, but the workspace opens.
        if (!changes.ok) {
            this.note(`not committed: git status failed (${changes.error})`);
            this.uncommitted = new Set([...this.settings.modelFiles.keys()].map(f => pathKey(f)));
            return;
        }
        // Keys: git gives `C:/…` on Windows, and the case of a folder name can differ from the case in Catenary.
        const written = new Set(this.written.map(f => pathKey(f))), read = new Set(reloaded.map(f => pathKey(f)));
        const changed = changes.files.map(f => pathKey(f));
        // A mark stays while git shows the file as changed: a later read of another file does not remove it.
        this.uncommitted = new Set(changed.filter(k => this.uncommitted.has(k) || !written.has(k) || read.has(k)));
    }

    /**
     * The written paths to commit: not the files with changes in git that Catenary did not write (a note for each). None when
     * ws:autoCommit is false or the workspace is not in a repository: then no git command runs.
     */
    committable(): string[] {
        if (!this.commits) return [];
        return [...new Set(this.written)].filter(file => {
            if (!this.uncommitted.has(pathKey(file))) return true;
            this.note(`not committed: ${portableRelative(this.settings.folder, file)} has changes that are not committed`);
            return false;
        });
    }

    /** The data and shapes triples of each requested file (store form). */
    protected filesTriples(files: string[]): Map<string, Quad[]> {
        return new Map(files.map(f => [f, [...this.graph.match(null, null, null, rdf.namedNode(shapesGraphIri(f))).map(toTriple), ...this.graph.match(null, null, null, rdf.namedNode(dataGraphIri(f))).map(toTriple)]]));
    }

    protected viewTriples(view: NamedNode): Quad[] {
        return this.graph.match(null, null, null, view).map(toTriple);
    }

    /** Canonical form of each file, as a save writes it. */
    protected current(): Canonical {
        const event = this.graph.keys.persisted, s = this.settings;
        if (this.cache?.event === event) return this.cache.canonical;
        const before = this.stale === 'all' ? undefined : this.cache?.canonical;
        const stale = this.stale;
        const fresh = (k: string) => stale !== 'all' && !stale.has(k);
        const reuse = (f: string) => fresh('f:' + f) ? before?.files.get(f) : undefined;
        const triples = this.filesTriples([...s.modelFiles.keys()].filter(f => reuse(f) === undefined));
        const value = {
            workspace: canonical(manifestQuads(s.manifest(), s.workspace.path)),
            files: new Map([...s.modelFiles.keys()].map(f => [f, reuse(f) ?? canonical(triples.get(f)!)])),
            views: new Map(views(this.graph).map(v => [v.value, (fresh('v:' + v.value) ? before?.views.get(v.value) : undefined) ?? canonical(this.viewTriples(v))]))
        };
        this.cache = { event, canonical: value };
        this.stale = new Set();
        return value;
    }

    /** The cache entries of `current` that a change of these quads makes out of date. */
    protected touch(quads: Iterable<Quad>): void {
        if (this.stale === 'all') return;
        for (const q of quads) {
            if (this.graph.isDataGraph(q.graph) || this.graph.isShapesGraph(q.graph)) this.stale.add('f:' + fileOfGraph(q.graph.value));
            else this.stale.add('v:' + q.graph.value);
        }
    }

    /**
     * The new text of a file with `triples`. Turtle, or a TriG view file (`graph`: its one graph), that Catenary read or wrote before: the
     * old text with a patch (text-patch.ts), checked by a read of the new text. Else, or when the patch is refused or wrong: the whole
     * file. A file changed on disk since Catenary read or wrote it is not written (error). `expected`: the canonical form of `triples` (the save has it).
     * `diff`: the changes since the last write, when known: then the patch reads only their blocks.
     */
    protected async fileText(f: OnDisk & { path: string }, triples: Quad[], expected: string, graph?: NamedNode, diff?: StatementDiff): Promise<string> {
        const problem = this.settings.readOnlyReason(f.path);
        if (problem) throw new Error(problem);
        // Undefined: not on disk (a new file, or removed): write it.
        const disk = await readUnchanged(f.path, f.text);
        const whole = () => tracer.span('file', 'whole file', () => serializeRdf(graph ? triples.map(q => rdf.quad(q.subject, q.predicate, q.object, graph)) : triples, f.path));
        if (!(graph ? /\.trig$/i : /\.ttl$/i).test(f.path)) return whole();
        if (disk !== undefined && f.triples) {
            const r = await tracer.span('file', 'text patch', () => diff ? patchTurtleDiff(disk, f.path, diff, PREFIXES, graph) : patchTurtle(disk, f.path, f.triples!, triples, PREFIXES, graph));
            if (r.ok && await tracer.span('file', 'read back', () => sameTriples(r.text, f.path, expected, graph))) return r.text;
            this.note(`${path.basename(f.path)}: written as a whole (${r.ok ? 'the patch did not read back as the model' : r.reason}).`);
        }
        if (graph) return whole();
        // The whole file in the style of the patcher: the prefixes that it uses, then one block for each subject.
        const header = Object.entries(PREFIXES).map(([p, ns]) => `@prefix ${p}: <${ns}> .`).join('\n') + '\n';
        const generated = await patchTurtle(header, f.path, [], triples);
        if (generated.ok) {
            const body = generated.text.slice(header.length);
            const used = Object.keys(PREFIXES).filter(p => body.includes(`${p}:`)).map(p => `@prefix ${p}: <${PREFIXES[p]}> .`).join('\n');
            const text = `${used}\n${body}`;
            if (await sameTriples(text, f.path, expected)) return text;
        }
        this.note(`${path.basename(f.path)}: written by triplify (${generated.ok ? 'the whole-file text did not read back as the model' : generated.reason}).`);
        return whole();
    }
}

/** `text` reads back as the triples whose canonical form is `expected`; with `graph`, each one in that graph. */
async function sameTriples(text: string, file: string, expected: string, graph?: NamedNode): Promise<boolean> {
    try {
        const quads = /\.(ttl|trig)$/i.test(file) ? parseTurtleText(text, file) : await parseRdf(text, file);
        if (graph ? !quads.every(q => q.graph.equals(graph)) : quads.some(q => q.graph.termType !== 'DefaultGraph')) return false;
        return canonical(quads.map(toTriple)) === expected;
    } catch {
        return false;
    }
}
