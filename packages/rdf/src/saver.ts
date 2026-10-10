// The saver (ADR 0003): what differs from the files on disk, and the save. A save writes each changed file (Turtle that Catenary read
// or wrote: a patch of its text, text-patch.ts), all or none, and records the written paths for the commit. The canonical form of each
// file is cached and computed again only for the files that a change touched.

import { CommandResult, PREFIXES } from '@catenary/model';
import type { NamedNode, Quad } from '@rdfjs/types';
import { promises as fs } from 'fs';
import * as path from 'path';
import { OwnWrites, gitChanges, patchTurtle, pathKey, portableRelative, readUnchanged, writeAll } from 'rdf-files';
import { manifestQuads, parseRdf, serializeRdf, writeProblem } from './files';
import { ModelGraph, dataGraphIri, fileGraphIri, fileOfGraph } from './graph';
import { OnDisk, Saved, Settings } from './settings';
import { rdf } from './terms';
import { canonical, writeTrig } from './trig';

interface Canonical { workspace: string; files: Map<string, string>; views: Map<string, string> }

const EMPTY = canonical([]);

const toTriple = (q: Quad) => rdf.quad(q.subject, q.predicate, q.object);

export class Saver {
    /** Written or removed paths awaiting a successful commit. */
    written: string[] = [];
    /** The text of each write and each removal of this workspace: their watch events are not changes on disk. */
    readonly ownWrites = new OwnWrites();
    /** pathKey of each file with changes in git that Catenary did not write. */
    protected uncommitted = new Set<string>();
    protected cache?: { event: unknown; canonical: Canonical };
    /**
     * The entries of `cache` that a change made out of date: `f:<path>` a model file, `v:<view IRI>` a view. 'all': every entry. Each
     * change of the store marks its graphs, so that the next save computes the canonical form of the files it touched only.
     */
    protected stale: Set<string> | 'all' = 'all';

    constructor(protected readonly graph: ModelGraph, protected readonly settings: Settings, protected readonly note: (text: string) => void) {
        graph.onDidChange(event => this.touch(event.patch.map(c => c.quad)));
    }

    /** Compute every file again at the next `current` (after a read of files). */
    forget(): void {
        this.stale = 'all';
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
        const s = this.settings, saved = this.savedState();
        const problem = [...saved.files].map(f => writeProblem(f)).find(p => !!p);
        if (problem) return { ok: false, error: `${problem}. Convert the file to Turtle first.` };
        const kept = [...saved.files, ...[...saved.views].map(v => s.viewFiles.get(v)?.path)].find(f => f && s.noWrite.has(f));
        if (kept) return { ok: false, error: `${path.basename(kept)}: ${s.noWrite.get(kept)}` };
        // Read the content now: edits during the writes do not count as saved.
        const now = this.current();
        type Write = { file: string; text: string; done: () => void };
        const writes: Write[] = [];
        // A file is written when it changed. `graph`: a view file, written as TriG with one graph (the view).
        const onDisk = async (f: OnDisk & { path: string; saved?: string }, changed: boolean, triples: () => Quad[], content: string, graph?: NamedNode) => {
            if (!changed) return;
            const all = triples();
            const text = await this.fileText(f, all, content, graph);
            writes.push({ file: f.path, text, done: () => Object.assign(f, { saved: content, text, triples: all, blanks: 0 }) });
        };
        try {
            for (const f of s.modelFiles.values()) if (!f.error) await onDisk(f, saved.files.has(f.path), () => this.filesTriples([f.path]).get(f.path)!, now.files.get(f.path)!);
            for (const v of this.graph.views()) {
                const f = s.viewFiles.get(v.value);
                if (f) await onDisk(f, saved.views.has(v.value), () => this.viewTriples(v), now.views.get(v.value)!, v);
            }
        } catch (e) {
            return { ok: false, error: (e as Error).message };
        }
        const w = s.workspace;
        if (saved.workspace) {
            const text = await writeTrig(manifestQuads(s.manifest(), w.path));
            writes.push({ file: w.path, text, done: () => Object.assign(w, { saved: now.workspace, text }) });
        }
        if (s.retired) return { ok: false, error: 'Another workspace was opened during the save.' };
        // All files or none: temporary files first, then a rename of each.
        const error = writes.length ? await writeAll(writes, ({ file, text, done }) => {
            this.ownWrites.note(file, text);
            this.written.push(file);
            done();
        }, '.catenary-tmp') : undefined;
        if (error) return { ok: false, error };
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
     * are not committed, so that a commit never takes changes of the user. Outside a repository: one warning.
     */
    async recordUncommitted(reloaded: string[] = []): Promise<void> {
        const changes = await gitChanges(this.settings.folder);
        if (!changes.ok && !changes.repo) {
            this.note('not committed: workspace is not a git repository');
            return;
        }
        // No status (for example a locked or damaged index): no auto-commit at all, but the workspace opens.
        if (!changes.ok) {
            this.note(`not committed: git status failed (${changes.error})`);
            this.uncommitted = new Set([...this.settings.modelFiles.keys()].map(f => pathKey(f)));
            return;
        }
        // Keys: git gives `C:/…` on Windows, and the case of a folder name can differ from the case in Catenary.
        const written = new Set(this.written.map(f => pathKey(f))), read = new Set(reloaded.map(f => pathKey(f)));
        this.uncommitted = new Set(changes.files.map(f => pathKey(f)).filter(k => !written.has(k) || read.has(k)));
    }

    /** The written paths to commit: not the files with changes in git that Catenary did not write (a note for each). */
    committable(): string[] {
        return [...new Set(this.written)].filter(file => {
            if (!this.uncommitted.has(pathKey(file))) return true;
            this.note(`not committed: ${portableRelative(this.settings.folder, file)} has changes that are not committed`);
            return false;
        });
    }

    /** The data and shapes triples of each requested file (store form). */
    protected filesTriples(files: string[]): Map<string, Quad[]> {
        return new Map(files.map(f => [f, [...this.graph.match(null, null, null, rdf.namedNode(fileGraphIri(f))).map(toTriple), ...this.graph.match(null, null, null, rdf.namedNode(dataGraphIri(f))).map(toTriple)]]));
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
            views: new Map(this.graph.views().map(v => [v.value, (fresh('v:' + v.value) ? before?.views.get(v.value) : undefined) ?? canonical(this.viewTriples(v))]))
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
     * The new text of a file with `triples`. Turtle that Catenary read or wrote before: the old text with a patch (text-patch.ts), checked
     * by a read of the new text. Else, or when the patch is refused or wrong: the whole file. A file changed on disk since Catenary read
     * or wrote it is not written (error). `expected`: the canonical form of `triples` (the save has it).
     */
    protected async fileText(f: OnDisk & { path: string }, triples: Quad[], expected: string, graph?: NamedNode): Promise<string> {
        const problem = this.settings.writeProblemOf(f.path);
        if (problem) throw new Error(problem);
        // Undefined: not on disk (a new file, or removed): write it.
        const disk = await readUnchanged(f.path, f.text);
        const whole = () => serializeRdf(graph ? triples.map(q => rdf.quad(q.subject, q.predicate, q.object, graph)) : triples, f.path);
        if (graph || !/\.ttl$/i.test(f.path)) return whole();
        if (disk !== undefined && f.triples) {
            const r = await patchTurtle(disk, f.path, f.triples, triples, PREFIXES);
            if (r.ok && await sameTriples(r.text, f.path, expected)) return r.text;
            this.note(`${path.basename(f.path)}: written as a whole (${r.ok ? 'the patch did not read back as the model' : r.reason}).`);
        }
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

/** `text` reads back as the triples whose canonical form is `expected`. */
async function sameTriples(text: string, file: string, expected: string): Promise<boolean> {
    try {
        return canonical((await parseRdf(text, file)).map(toTriple)) === expected;
    } catch {
        return false;
    }
}
