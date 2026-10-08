// The workspace on disk (ADR 0003, ADR 0004): the workspace file (the manifest), the model files, the dataset read from them, which
// file has each statement, where new statements go, what changed, and the save. An open makes a new Workspace.
// A file with one view:View is a view: its graph is the view IRI. In the other files, the shapes (shapePart) go to the graph of the file,
// the other statements to the model graph; `origin` gives the files of each statement of the model graph. A new statement goes to the
// file of its subject, else of a statement that refers to it, else by the placement of its kind (placement.ts).

import { CommandResult, DEFAULT_PREFIXES, FileKind, NS, PREFIXES, WorkspaceFiles, setPrefixes } from '@catenary/model';
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import {
    OxigraphStore, absolutePath, diskChanges, gitChanges, hasAnnotation, isInside, knownPath, pathKey, patchTurtle, portableRelative, readUnchanged,
    writeAll
} from 'rdf-files';
import {
    MANIFEST_GRAPH, Manifest, NEAR, Placement, VIEW_EXT, defaultPlacement, globRegExp, isViewFile, defaultViewsFolder, listModelFiles, manifestQuads,
    parseRdf, readManifest, serializeRdf, writeProblem
} from './files';
import { Change, ModelGraph, P, SKOS_TYPES, V, cmp, fileGraphIri, fileOfGraph, mint } from './graph';
import { elementTerm } from './ids';
import { filesOfSubject, nearFiles, placeOf } from './placement';
import { isSkolem, skolemize } from './skolem';
import { rdf, termKey, tripleKey } from './terms';
import { canonical, parseTrig, writeTrig } from './trig';

const PLACE_KINDS = ['shapes', 'concepts', 'instances'] as const;

export interface WorkspaceOptions {
    /** Changes each time the dataset changes: it keys the cache of the canonical forms. */
    content: () => number;
    /** A note of a read or a write (the warnings and the log). */
    note: (text: string) => void;
}

export class Workspace {
    readonly graph = new ModelGraph(new OxigraphStore());
    /** The workspace file: the manifest. */
    readonly workspace: WorkspaceFile;
    /** View graph IRI -> its view file. The entry of a deleted view stays until a save removes the file (an undo brings it back). */
    protected viewFiles = new Map<string, ViewFile>();
    /** Folder of the view file of the view that the running `createView` makes (its `folder`); undefined: `views/`. */
    newViewFolder?: string;
    /** The view file of the view that the running `createView` makes (its `file`); undefined: a free name in `newViewFolder`. */
    newViewFile?: string;
    /** The model files that are not views, by path. Their shapes are in the graph of the file, the rest in the model graph. */
    protected modelFiles = new Map<string, ModelFile>();
    /** Files that Catenary reads but does not write (path -> why), besides the formats it does not write (`writeProblem`). */
    protected noWrite = new Map<string, string>();
    /** Statement of the model graph (tripleKey) -> the files that have it. Change it with setOrigin, addOrigin and deleteOrigin only. */
    protected origin = new Map<string, Set<string>>();
    /** `origin` by file: file -> its statements of the model graph (tripleKey -> triple). The canonical form of a file reads it. */
    protected byFile = new Map<string, Map<string, Quad>>();
    /** The files of a statement that was removed: an undo puts it back there. */
    protected lastOrigin = new Map<string, Set<string>>();
    /** Manifest settings: the file for new subjects (undefined: not set), the placement by kind, the exclude globs. */
    protected defaultFileSetting?: string;
    protected placement: Placement;
    protected exclude: string[];
    /** Globs of the protected files (manifest ws:protect): Catenary reads them and refuses each change of their statements. */
    protected imported: string[];
    /** Prefix table of the workspace file. Undefined: the file declares none (DEFAULT_PREFIXES apply, the file stays as it is). */
    prefixes?: Record<string, string>;
    /** Written or removed paths awaiting a successful commit. */
    written: string[] = [];
    /** pathKey of each file with changes in git that Catenary did not write. */
    protected uncommitted = new Set<string>();
    /** The workspace file was removed or moved on disk: no watch, no reads, no writes until the next open. */
    gone = false;
    /** Another workspace was opened: a save of this one writes nothing. */
    retired = false;
    protected cache?: { content: number; canonical: Canonical };
    protected kindsCache?: { content: number; kinds: Map<string, Set<FileKind>> };
    /**
     * The entries of `cache` that a change made out of date: `f:<path>` a model file, `v:<view IRI>` a view. 'all': every entry (a read
     * of files). `track` and `mount` keep it, so that a change computes the canonical form of the files it touched only.
     */
    protected stale: Set<string> | 'all' = 'all';

    protected constructor(primaryPath: string, manifest: Manifest, text: string | undefined, protected readonly options: WorkspaceOptions) {
        // Saved state in the form that a save writes: another spelling of the same manifest is not a change.
        this.workspace = { path: primaryPath, saved: canonical(manifestQuads(manifest, primaryPath)), text };
        this.defaultFileSetting = manifest.defaultFile;
        this.placement = manifest.placement;
        this.exclude = manifest.exclude;
        this.imported = manifest.imported;
        this.prefixes = manifest.prefixes;
    }

    /**
     * Read a workspace file and its model files into a new dataset. `ofFolder`: the folder was given; a workspace file that is not on
     * disk is the default manifest. Sets the prefix table of the read models (before the files are read: the shapes read model compacts
     * IRIs with it).
     */
    static async open(primaryPath: string, ofFolder: boolean, options: WorkspaceOptions): Promise<{ error: string } | { workspace: Workspace; warnings: string[] }> {
        let primary: { manifest: Quad[]; warnings: string[]; text?: string };
        try {
            primary = ofFolder && !existsSync(primaryPath) ? { manifest: [], warnings: [] } : await readWorkspace(primaryPath);
        } catch (e) {
            return { error: (e as Error).message };
        }
        const manifest = readManifest(primary.manifest, primaryPath);
        // Before the files are read: the shapes read model compacts IRIs with them.
        setPrefixes(manifest.prefixes ?? DEFAULT_PREFIXES);
        const warnings: string[] = [...primary.warnings];
        const reads = await Promise.all((await listModelFiles(primaryPath, manifest.exclude)).map(readModelFile));
        // The spelling on disk (Windows: a manifest path in another case is the same file); the manifest is not changed by this.
        if (manifest.defaultFile) manifest.defaultFile = knownPath(reads.map(r => r.path), manifest.defaultFile);
        for (const k of PLACE_KINDS) if (manifest.placement[k] !== NEAR) manifest.placement[k] = knownPath(reads.map(r => r.path), manifest.placement[k]);

        const ws = new Workspace(primaryPath, manifest, primary.text, options);
        for (const r of reads) {
            if (typeof r === 'string') warnings.push(r);
            else ws.mount(r, warnings);
        }
        ws.syncShapesTarget();
        return { workspace: ws, warnings };
    }

    /** Path of the workspace file. */
    get path(): string {
        return this.workspace.path;
    }

    /** The folder of the workspace file: the model files are in it and its subfolders. */
    get folder(): string {
        return path.dirname(this.workspace.path);
    }

    /** The model file or view file at this path (the spelling of the store), or undefined. */
    knownFile(file: string): string | undefined {
        const all = [...this.modelFiles.keys(), ...[...this.viewFiles.values()].map(f => f.path)];
        return all.find(f => pathKey(f) === pathKey(file));
    }

    /** The view file of a view graph IRI. */
    viewFile(view: string): { path: string } | undefined {
        return this.viewFiles.get(view);
    }

    /** A view graph whose IRI changed stays in its view file. */
    moveViewFile(from: string, to: string): void {
        const f = this.viewFiles.get(from);
        if (!f) return;
        this.viewFiles.delete(from);
        this.viewFiles.set(to, f);
    }

    /** The names of the files with shapes (the sources of the metamodel). */
    shapeSources(): string[] {
        return [...this.modelFiles.keys()].filter(f => this.graph.match(null, null, null, rdf.namedNode(fileGraphIri(f))).length).map(f => path.basename(f));
    }

    /** The files of the workspace and their state; `views`: the view ids of the read model. */
    info(views: string[]): WorkspaceFiles {
        const saved = this.savedState();
        const kinds = this.fileKinds();
        return {
            workspace: { path: this.workspace.path, dirty: saved.workspace, onDisk: this.workspace.text !== undefined },
            defaultFile: { path: this.defaultFile, set: this.defaultFileSetting !== undefined },
            placement: { ...this.placement },
            exclude: [...this.exclude],
            imported: [...this.imported],
            files: [...this.modelFiles.values()].sort((a, b) => cmp(a.path, b.path))
                .map(f => ({
                    path: f.path, dirty: saved.files.has(f.path), ...(f.error ? { error: f.error } : {}), ...(this.isImported(f.path) ? { imported: true } : {}),
                    kinds: [...kinds.get(f.path) ?? []].sort()
                })),
            views: views.map(v => {
                const file = this.viewFiles.get(elementTerm(v)!.value)!.path;
                return { view: v, path: file, dirty: saved.views.has(elementTerm(v)!.value), ...(this.isImported(file) ? { imported: true } : {}) };
            })
        };
    }

    /** The files of a statement: the model graph by the origin of the triple, a shapes graph its file, a view graph its view file. */
    filesOfQuad(q: Quad): string[] {
        if (q.graph.equals(this.graph.model)) return [...this.origin.get(tripleKey(q)) ?? []];
        if (this.graph.isShapesGraph(q.graph)) return [fileOfGraph(q.graph.value)];
        const f = this.viewFiles.get(q.graph.value)?.path;
        return f ? [f] : [];
    }

    /** The file of a new subject by the placement of its kind (placement.ts), as a model file record. */
    protected place(s: Term): string {
        const f = placeOf(this.graph, this.origin, this.placement, file => this.placeFile(file), s);
        this.modelFile(f);
        return f;
    }

    /** The files of a subject (most statements first). */
    filesOfSubject(t: Term): string[] {
        return filesOfSubject(this.graph, this.origin, t);
    }

    /** What each model file contains: shapes (its graph has quads), concepts and instances (typed subjects of the model graph). */
    protected fileKinds(): Map<string, Set<FileKind>> {
        const content = this.options.content();
        if (this.kindsCache?.content === content) return this.kindsCache.kinds;
        const kinds = new Map<string, Set<FileKind>>();
        this.kindsCache = { content, kinds };
        const add = (file: string, k: FileKind) => (kinds.get(file) ?? kinds.set(file, new Set()).get(file)!).add(k);
        for (const f of this.modelFiles.keys()) if (this.graph.match(null, null, null, rdf.namedNode(fileGraphIri(f))).length) add(f, 'shapes');
        for (const q of this.graph.match(null, P.type, null, this.graph.model)) {
            const k: FileKind = SKOS_TYPES.some(t => t.equals(q.object)) ? 'concepts' : 'instances';
            for (const f of this.origin.get(tripleKey(q)) ?? []) add(f, k);
        }
        return kinds;
    }

    protected manifest(): Manifest {
        return {
            ...(this.defaultFileSetting ? { defaultFile: this.defaultFileSetting } : {}), placement: { ...this.placement }, exclude: [...this.exclude],
            imported: [...this.imported],
            ...(this.prefixes ? { prefixes: this.prefixes } : {})
        };
    }

    /**
     * The file for new subjects when "near" finds no file, and for additions to read-only files: a writable setting, else a nonempty
     * writable file that is not the file of shapes or SKOS resources (Turtle first), else `<workspace name>.ttl`.
     */
    get defaultFile(): string {
        const writable = (file: string) => !this.writeProblemOf(file) && (path.extname(file).toLowerCase() !== '.json' || this.modelFiles.has(file));
        if (this.defaultFileSetting && writable(this.defaultFileSetting)) return this.defaultFileSetting;
        const kindFiles = new Set([this.placement.shapes, this.placement.concepts].map(f => pathKey(f)));
        const files = [...this.modelFiles.values()].filter(f => !f.error && writable(f.path) && f.triples?.length && !kindFiles.has(pathKey(f.path)));
        return files.sort((a, b) =>
            Number(/\.(ttl|turtle)$/i.test(b.path)) - Number(/\.(ttl|turtle)$/i.test(a.path)) || cmp(a.path, b.path))[0]?.path
            ?? this.workspace.path.replace(/\.trig$/, '') + '.ttl';
    }

    /** A model file record for `file` (a new file: not on disk yet). */
    protected modelFile(file: string): ModelFile {
        let f = this.modelFiles.get(file);
        if (!f) this.modelFiles.set(file, f = { path: file });
        return f;
    }

    /** A file of the placement when Catenary can write it, else the default file. */
    protected placeFile(file: string | undefined): string {
        return file && !this.writeProblemOf(file) ? file : this.defaultFile!;
    }

    /** The graph for new shapes: the file of the placement, or ("near") the file with most node shapes. The shapes graphs of the store. */
    syncShapesTarget(): void {
        let target = this.placeFile(this.placement.shapes === NEAR ? undefined : this.placement.shapes);
        if (this.placement.shapes === NEAR) {
            const count = (f: string) => this.graph.match(null, P.type, rdf.namedNode(NS.sh + 'NodeShape'), rdf.namedNode(fileGraphIri(f))).length;
            const best = [...this.modelFiles.keys()].filter(f => !this.writeProblemOf(f)).map(f => [f, count(f)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0];
            if (best) target = best[0];
        }
        this.modelFile(target);
        this.graph.setShapesGraphs([...this.modelFiles.keys()].map(f => rdf.namedNode(fileGraphIri(f))));
        this.graph.primaryShapes = rdf.namedNode(fileGraphIri(target));
    }

    /**
     * Why `file` cannot be the file of a new view, or undefined. It is a TriG file in the workspace folder that is not on disk and not
     * a file of the workspace. The name does not matter: the read finds the views in a file by its content (`declaredViews`).
     */
    newViewFileProblem(file: string): string | undefined {
        const name = portableRelative(this.folder, file);
        if (!isInside(this.folder, file)) return `${name}: the file must be in the folder of the workspace file.`;
        if (!/\.trig$/i.test(file)) return `${path.basename(file)}: a view file is a TriG file (.trig).`;
        const known = [this.workspace, ...this.viewFiles.values(), ...this.modelFiles.values()];
        if (known.some(f => pathKey(f.path) === pathKey(file)) || existsSync(file)) return `${name} exists. Type another file name.`;
        return undefined;
    }

    /**
     * A view file for each view that has none: the `file` of `createView`, else `<label>.view.trig` (`-2`, … when taken) in the folder
     * of `createView`, else in `views/` next to the workspace file.
     */
    assignViewFiles(): void {
        const folder = this.newViewFolder ?? defaultViewsFolder(this.workspace.path);
        const taken = new Set([...this.viewFiles.values()].map(f => f.path));
        for (const v of this.graph.views()) {
            if (this.viewFiles.has(v.value)) continue;
            if (this.newViewFile && !taken.has(this.newViewFile)) {
                taken.add(this.newViewFile);
                this.viewFiles.set(v.value, { path: this.newViewFile });
                this.newViewFile = undefined;
                continue;
            }
            const base = this.graph.label(v, v).replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'view';
            let file = path.join(folder, `${base}${VIEW_EXT}`);
            for (let i = 2; taken.has(file) || existsSync(file); i++) file = path.join(folder, `${base}-${i}${VIEW_EXT}`);
            taken.add(file);
            this.viewFiles.set(v.value, { path: file });
        }
    }

    /** The statements of a model file (store form): its shapes graph and its statements of the model graph. */
    protected fileTriples(file: string): Quad[] {
        return this.filesTriples([file]).get(file)!;
    }

    /** `fileTriples` of several files: the quads of their shapes graphs and their statements of the model graph (`byFile`). */
    protected filesTriples(files: string[]): Map<string, Quad[]> {
        return new Map(files.map(f => [f, [...this.graph.match(null, null, null, rdf.namedNode(fileGraphIri(f))).map(toTriple), ...this.byFile.get(f)?.values() ?? []]]));
    }

    /** Canonical form of each file, as a save writes it. */
    protected current(): Canonical {
        const content = this.options.content();
        if (this.cache?.content === content) return this.cache.canonical;
        const before = this.stale === 'all' ? undefined : this.cache?.canonical;
        const stale = this.stale;
        const fresh = (k: string) => stale !== 'all' && !stale.has(k);
        const reuse = (f: string) => fresh('f:' + f) ? before?.files.get(f) : undefined;
        const triples = this.filesTriples([...this.modelFiles.keys()].filter(f => reuse(f) === undefined));
        const value = {
            workspace: canonical(manifestQuads(this.manifest(), this.workspace.path)),
            files: new Map([...this.modelFiles.keys()].map(f => [f, reuse(f) ?? canonical(triples.get(f)!)])),
            views: new Map(this.graph.views().map(v => [v.value, (fresh('v:' + v.value) ? before?.views.get(v.value) : undefined) ?? canonical(this.viewTriples(v))]))
        };
        this.cache = { content, canonical: value };
        this.stale = new Set();
        return value;
    }

    /** The cache entries of `current` that a change of these quads makes out of date (call after `origin` has the change). */
    protected touch(quads: Iterable<Quad>): void {
        if (this.stale === 'all') return;
        for (const q of quads) {
            if (q.graph.equals(this.graph.model)) {
                const k = tripleKey(q);
                for (const f of [...this.origin.get(k) ?? [], ...this.lastOrigin.get(k) ?? []]) this.stale.add('f:' + f);
            } else if (this.graph.isShapesGraph(q.graph)) this.stale.add('f:' + fileOfGraph(q.graph.value));
            else this.stale.add('v:' + q.graph.value);
        }
    }

    protected viewTriples(view: NamedNode): Quad[] {
        return this.graph.match(null, null, null, view).map(toTriple);
    }

    /** Which files differ from the saved ones. `views`: view graphs not saved; `deleted`: files of deleted views, still on disk. */
    protected savedState(): { workspace: boolean; files: Set<string>; views: Set<string>; deleted: string[] } {
        const now = this.current();
        return {
            workspace: now.workspace !== this.workspace.saved,
            files: new Set([...this.modelFiles.values()].filter(f => !f.error && now.files.get(f.path) !== (f.saved ?? EMPTY)).map(f => f.path)),
            views: new Set([...now.views].filter(([v, text]) => this.viewFiles.get(v)?.saved !== text).map(([v]) => v)),
            deleted: [...this.viewFiles].filter(([v, f]) => !now.views.has(v) && f.saved !== undefined).map(([v]) => v)
        };
    }

    /** Undefined, or why Catenary does not write this file: its format (`writeProblem`), its content (`noWrite`), or an import mark (ws:imported). */
    protected writeProblemOf(file: string): string | undefined {
        return writeProblem(file) ?? (this.noWrite.has(file) ? `${path.basename(file)}: ${this.noWrite.get(file)}` : undefined)
            ?? (this.isImported(file) ? `${path.basename(file)} is an imported file.` : undefined);
    }

    /** A ws:imported glob matches the path of the file relative to the workspace folder. */
    isImported(file: string, globs = this.imported): boolean {
        if (!globs.length || !isInside(this.folder, file)) return false;
        const rel = portableRelative(this.folder, file);
        return globs.some(g => globRegExp(g).test(rel));
    }

    /** The imported globs (manifest ws:imported). */
    get importedGlobs(): string[] {
        return [...this.imported];
    }

    /**
     * The imported files that a patch changes (sorted): a statement of the model graph that leaves an imported file, any change of a
     * shapes graph or a view graph of an imported file. A statement that the patch removes and adds again (or the reverse) is no
     * change. Call it before `track`: `origin` has the files of the statements before the patch. A new statement of the model graph
     * never goes to a protected file (`track`).
     */
    importedChanges(changes: readonly Change[]): string[] {
        if (!this.imported.length) return [];
        const first = new Map<string, Change>(), last = new Map<string, Change>();
        for (const c of changes) {
            const k = `${tripleKey(c.quad)} ${termKey(c.quad.graph)}`;
            if (!first.has(k)) first.set(k, c);
            last.set(k, c);
        }
        const files = new Set<string>();
        for (const [k, c] of last) {
            if (first.get(k)!.op !== c.op) continue;
            if (c.quad.graph.equals(this.graph.model) && c.op === 'add') continue;
            for (const f of this.filesOfQuad(c.quad)) if (this.isImported(f)) files.add(f);
        }
        return [...files].sort(cmp);
    }

    /**
     * The statements of the model graph that SHACL validation reads (spec/manifest.hs §9). Imported files are read only, and they can
     * be large: their statements are not validated, except the ones that own statements need. So: the statements of own files, all
     * statements of their subjects (also from imported files), and the rdf:type statements of the IRIs that they refer to.
     * Undefined: no imported globs, so validation reads the whole model graph.
     */
    validationTriples(): Quad[] | undefined {
        if (!this.imported.length) return undefined;
        const out = new Map<string, Quad>();
        for (const [file, quads] of this.byFile) if (!this.isImported(file)) for (const [k, q] of quads) out.set(k, q);
        const subjects = new Map<string, Quad['subject']>(), objects = new Map<string, Quad['object']>();
        for (const q of out.values()) {
            subjects.set(termKey(q.subject), q.subject);
            if (q.object.termType === 'NamedNode') objects.set(termKey(q.object), q.object);
        }
        const add = (q: Quad) => { const t = toTriple(q); out.set(tripleKey(t), t); };
        for (const s of subjects.values()) this.graph.match(s, null, null, this.graph.model).forEach(add);
        for (const [k, o] of objects) if (!subjects.has(k)) this.graph.match(o as Quad['subject'], P.type, null, this.graph.model).forEach(add);
        return [...out.values()];
    }

    /** A file differs from the saved one. */
    get dirty(): boolean {
        const s = this.savedState();
        return s.workspace || s.files.size > 0 || s.views.size > 0 || s.deleted.length > 0;
    }

    /**
     * Put a file read into the store. A view: its graph (false when another file has the view). Another file: its shapes to the graph
     * of the file, the rest to the model graph, with `origin`. Blank nodes get IRIs (skolem.ts); a save writes the IRIs.
     */
    mount(r: FileRead, notes: string[]): boolean {
        this.stale = 'all';
        this.graph.shapesChanged();
        const name = portableRelative(this.folder, r.path);
        if (r.kind === 'error') {
            this.modelFiles.set(r.path, { path: r.path, error: r.error });
            notes.push(`${name}: not read: ${r.error}`);
            return false;
        }
        notes.push(...r.warnings);
        if (r.noWrite) { this.noWrite.set(r.path, r.noWrite); notes.push(`${name}: ${r.noWrite}`); } else this.noWrite.delete(r.path);
        if (r.kind === 'view') {
            if (this.graph.isView(rdf.namedNode(r.view))) { notes.push(`${name}: not read: the view ${r.view} is in another file too.`); return false; }
            const read = r.triples.map(q => rdf.quad(q.subject, q.predicate, q.object, rdf.namedNode(r.view)));
            const { quads, count } = skolemize(read);
            // A file with blank nodes differs from its saved form: the next save writes the IRIs (not a file that Catenary does not write).
            const keep = !this.writeProblemOf(r.path);
            if (count) notes.push(keep ? skolemNote(r.path, count) : unwrittenBlankNote(r.path));
            for (const q of quads) this.graph.store.add(q);
            this.viewFiles.set(r.view, { path: r.path, saved: canonical((count && keep ? read : quads).map(toTriple)), text: r.text, triples: quads.map(toTriple), blanks: count });
            return true;
        }
        const { quads, count } = skolemize(r.triples);
        // A file that Catenary does not write keeps its blank nodes on disk: its saved form is the read with IRIs.
        const keep = !this.writeProblemOf(r.path);
        if (count) notes.push(keep ? skolemNote(r.path, count) : unwrittenBlankNote(r.path));
        const shapes = shapePart(quads), graph = rdf.namedNode(fileGraphIri(r.path));
        for (const q of quads) {
            if (shapes.has(termKey(q.subject))) { this.graph.store.add(rdf.quad(q.subject, q.predicate, q.object, graph)); continue; }
            this.graph.store.add(rdf.quad(q.subject, q.predicate, q.object, this.graph.model));
            this.addOrigin(tripleKey(q), r.path, q);
        }
        this.modelFiles.set(r.path, { path: r.path, saved: canonical(count && keep ? r.triples : quads), text: r.text, triples: quads, blanks: count });
        return true;
    }

    /** Take a file out of the store: a view file its view; a model file its shapes graph and its statements of the model graph. */
    protected unmount(file: string): void {
        this.stale = 'all';
        this.graph.shapesChanged();
        for (const [iri, f] of [...this.viewFiles]) {
            if (f.path !== file) continue;
            for (const q of this.graph.match(null, null, null, rdf.namedNode(iri))) this.graph.store.delete(q);
            this.viewFiles.delete(iri);
        }
        if (!this.modelFiles.has(file)) return;
        for (const q of this.graph.match(null, null, null, rdf.namedNode(fileGraphIri(file)))) this.graph.store.delete(q);
        for (const [k, q] of this.byFile.get(file) ?? []) {
            const o = this.origin.get(k);
            if (!o?.delete(file)) continue;
            if (!o.size) {
                this.origin.delete(k);
                this.graph.store.delete(rdf.quad(q.subject, q.predicate, q.object, this.graph.model));
            }
        }
        this.byFile.delete(file);
        this.modelFiles.delete(file);
    }

    /**
     * Keep `origin` in step with changes of the model graph (in the order applied): a removed statement leaves its files (remembered
     * for an undo); an added one goes to the files it had before, else to the file of its subject, else of a statement that refers to
     * its subject, else by the placement of its kind.
     */
    track(changes: Change[]): void {
        let adds: Quad[] = [];
        for (const c of changes) {
            if (!c.quad.graph.equals(this.graph.model)) continue;
            const k = tripleKey(c.quad);
            if (c.op === 'remove') {
                const o = this.origin.get(k);
                if (o) { this.lastOrigin.set(k, o); this.deleteOrigin(k); }
                adds = adds.filter(q => tripleKey(q) !== k);
            } else if (!this.origin.has(k)) {
                // An IRI change: the files of the statement that this one replaces.
                const was = c.was && this.lastOrigin.get(tripleKey(c.was));
                if (was?.size) this.lastOrigin.set(k, was);
                adds.push(c.quad);
            }
        }
        for (let round = 0; adds.length && round < 64; round++) {
            const rest = adds.filter(q => {
                const files = this.lastOrigin.get(tripleKey(q)) ?? nearFiles(this.graph, this.origin, q.subject);
                if (!files?.size) return true;
                const writable = [...files].map(f => this.writeProblemOf(f) ? this.defaultFile! : f);
                writable.forEach(f => this.modelFile(f));
                this.setOrigin(tripleKey(q), new Set(writable), q);
                return false;
            });
            if (rest.length === adds.length) break;
            adds = rest;
        }
        for (const q of adds) this.setOrigin(tripleKey(q), new Set([this.place(q.subject)]), q);
        this.touch(changes.map(c => c.quad));
    }

    /** The files of statement `k` (the triple of `q`) are `files`. */
    protected setOrigin(k: string, files: Set<string>, q: Quad): void {
        for (const f of this.origin.get(k) ?? []) if (!files.has(f)) this.byFile.get(f)?.delete(k);
        this.origin.set(k, files);
        const t = toTriple(q);
        for (const f of files) (this.byFile.get(f) ?? this.byFile.set(f, new Map()).get(f)!).set(k, t);
    }

    /** Statement `k` (the triple of `q`) is also in `file`. */
    protected addOrigin(k: string, file: string, q: Quad): void {
        (this.origin.get(k) ?? this.origin.set(k, new Set()).get(k)!).add(file);
        (this.byFile.get(file) ?? this.byFile.set(file, new Map()).get(file)!).set(k, toTriple(q));
    }

    /** Statement `k` is in no file (removed from the model graph). */
    protected deleteOrigin(k: string): void {
        for (const f of this.origin.get(k) ?? []) this.byFile.get(f)?.delete(k);
        this.origin.delete(k);
    }

    /**
     * Read again the model files that another program changed (the text on disk is not the text that Catenary last read or wrote), and
     * the files that are new or removed in the folder. `read`: the names of the files read or removed; `unmounted`: the names of the
     * files taken out of the store.
     */
    async readChanges(): Promise<{ read: string[]; notes: string[]; unmounted: Set<string> }> {
        const pending = this.savedState();
        const members = new Set(await listModelFiles(this.workspace.path, this.exclude));
        const known = new Map<string, OnDisk & { path: string; error?: string }>([...this.modelFiles.values(), ...this.viewFiles.values()].map(f => [f.path, f]));
        const read: string[] = [], notes: string[] = [];
        const name = (file: string) => portableRelative(this.folder, file);
        // The "not read" warnings of these files are replaced: the file is gone, or read again (a new failure gives a new warning).
        const unmounted = new Set<string>();
        // A file without text and without a read error is not written yet: not a removal.
        const changes = await diskChanges([...known.values()].map(f => ({ path: f.path, text: f.text, unwritten: f.error === undefined })), members);
        for (const file of changes.removed) {
            const f = known.get(file)!;
            this.unmount(file);
            unmounted.add(name(file));
            read.push(name(file));
            notes.push(f.error === undefined ? `${name(file)} was removed on disk: its statements are removed.` : `${name(file)} was removed on disk.`);
        }
        for (const { path: file, known: f } of changes.read) {
            const lost = f && (pending.files.has(file) || [...this.viewFiles].some(([v, x]) => x.path === file && pending.views.has(v)));
            this.unmount(file);
            unmounted.add(name(file));
            const r = await readModelFile(file);
            if (typeof r === 'string') { notes.push(r); continue; }
            if (!this.mount(r, notes)) continue;
            read.push(name(file));
            notes.push(f ? `${name(file)} changed on disk: read again${lost ? '; its changes that were not written are lost' : ''}.` : `${name(file)} is new on disk: read.`);
        }
        return { read, notes, unmounted };
    }

    /**
     * Check and apply settings of the manifest: the default file and the file of each kind (a model file, or a new RDF file in the
     * workspace folder; a kind: also "near"), the exclude globs, the imported globs (§2.6). `reread`: the exclude globs changed, so the
     * files must be read again.
     */
    applySettings(settings: { defaultFile?: string; placement?: Partial<Placement>; exclude?: string[]; imported?: string[] }): { error: string } | { reread: boolean } {
        // Imported globs first: the files of new subjects are checked against the new globs. An error keeps the old globs.
        const was = this.imported;
        if (settings.imported) {
            const globs = [...new Set(settings.imported.map(g => g.trim()).filter(Boolean))];
            const problem = this.importedProblem(globs);
            if (problem) return { error: problem };
            this.imported = globs;
        }
        const r = this.applyPlaces(settings);
        if ('error' in r) this.imported = was;
        return r;
    }

    /** `applySettings` without the imported globs. */
    protected applyPlaces(settings: { defaultFile?: string; placement?: Partial<Placement>; exclude?: string[] }): { error: string } | { reread: boolean } {
        /** A path relative to the workspace folder: the file, or why it cannot be a file for new subjects. */
        const fileOf = (rel: string): { file: string } | { error: string } => {
            const file = path.resolve(this.folder, rel);
            if (!isInside(this.folder, file)) return { error: `${rel}: the file must be in the folder of the workspace file.` };
            const problem = this.writeProblemOf(file);
            if (problem) return { error: problem };
            if ([...this.viewFiles.values(), this.workspace].some(f => pathKey(f.path) === pathKey(file))) return { error: `${path.basename(file)} is a view or the workspace file.` };
            return { file: knownPath(this.modelFiles.keys(), file) };
        };
        const next = { ...this.placement };
        for (const [k, v] of Object.entries(settings.placement ?? {})) {
            if (!(PLACE_KINDS as readonly string[]).includes(k) || typeof v !== 'string' || !v.trim()) return { error: `Placement ${k}: "${v}" (use "near" or a file path).` };
            if (v === NEAR) { next[k as keyof Placement] = NEAR; continue; }
            const r = fileOf(v.trim());
            if ('error' in r) return { error: r.error };
            next[k as keyof Placement] = r.file;
        }
        // An empty default file clears the setting: the default file is automatic again.
        if (settings.defaultFile === '') this.defaultFileSetting = undefined;
        else if (settings.defaultFile !== undefined) {
            const r = fileOf(settings.defaultFile);
            if ('error' in r) return { error: r.error };
            this.defaultFileSetting = r.file;
        }
        this.placement = next;
        // A file of new subjects that the new globs imported: Auto again (its subjects go near their kind, else to the default file).
        for (const k of PLACE_KINDS) if (this.placement[k] !== NEAR && this.isImported(this.placement[k])) this.placement[k] = NEAR;
        if (this.defaultFileSetting && this.isImported(this.defaultFileSetting)) this.defaultFileSetting = undefined;
        if (!settings.exclude) return { reread: false };
        this.exclude = settings.exclude.map(g => g.trim()).filter(Boolean);
        return { reread: true };
    }

    /**
     * Undefined, or why these imported globs cannot apply: a file that they mark newly has changes that are not written, or blank
     * nodes on disk (the IRIs of a read would change at each read, and statements in other files would lose their subject).
     * The caller writes the pending changes first: a write gives the blank nodes of a file that Catenary writes their IRIs.
     */
    protected importedProblem(globs: string[]): string | undefined {
        const saved = this.savedState();
        const dirty = new Set([...saved.files, ...[...saved.views].map(v => this.viewFiles.get(v)?.path)]);
        for (const f of [...this.modelFiles.values(), ...this.viewFiles.values()]) {
            if (!this.isImported(f.path, globs) || this.isImported(f.path)) continue;
            const name = portableRelative(this.folder, f.path);
            if (dirty.has(f.path)) return `${name} has changes that are not written. Mark it as imported after the write.`;
            if (f.blanks) return `${name} has blank nodes, and Catenary does not write this file, so they cannot get IRIs. Import the file from outside the workspace folder: the import writes a Turtle copy with IRIs.`;
        }
        return undefined;
    }

    /** Write the changed files (all or none, see `writeAll`). The caller commits `written`. */
    async save(): Promise<CommandResult> {
        const saved = this.savedState();
        const problem = [...saved.files].map(f => writeProblem(f)).find(p => !!p);
        if (problem) return { ok: false, error: `${problem}. Convert the file to Turtle first.` };
        const kept = [...saved.files, ...[...saved.views].map(v => this.viewFiles.get(v)?.path)].find(f => f && this.noWrite.has(f));
        if (kept) return { ok: false, error: `${path.basename(kept)}: ${this.noWrite.get(kept)}` };
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
            for (const f of this.modelFiles.values()) if (!f.error) await onDisk(f, saved.files.has(f.path), () => this.fileTriples(f.path), now.files.get(f.path)!);
            for (const v of this.graph.views()) {
                const f = this.viewFiles.get(v.value);
                if (f) await onDisk(f, saved.views.has(v.value), () => this.viewTriples(v), now.views.get(v.value)!, v);
            }
        } catch (e) {
            return { ok: false, error: (e as Error).message };
        }
        const w = this.workspace;
        if (saved.workspace) {
            const text = await writeTrig(manifestQuads(this.manifest(), w.path));
            writes.push({ file: w.path, text, done: () => Object.assign(w, { saved: now.workspace, text }) });
        }
        if (this.retired) return { ok: false, error: 'Another workspace was opened during the save.' };
        // All files or none: temporary files first, then a rename of each.
        const error = await writeAll(writes, ({ file, done }) => {
            this.written.push(file);
            done();
        }, '.catenary-tmp');
        if (error) return { ok: false, error };
        for (const v of saved.deleted) {
            const f = this.viewFiles.get(v)!;
            try {
                await fs.rm(f.path, { force: true });
            } catch (e) {
                return { ok: false, error: `Cannot remove ${f.path}: ${(e as Error).message}` };
            }
            this.written.push(f.path);
            this.viewFiles.delete(v);
        }
        return { ok: true };
    }

    /**
     * The new text of a file with `triples`. Turtle that Catenary read or wrote before: the old text with a patch (text-patch.ts), checked
     * by a read of the new text. Else, or when the patch is refused or wrong: the whole file. A file changed on disk since Catenary read
     * or wrote it is not written (error). `expected`: the canonical form of `triples` (the save has it).
     */
    protected async fileText(f: OnDisk & { path: string }, triples: Quad[], expected: string, graph?: NamedNode): Promise<string> {
        const problem = this.writeProblemOf(f.path);
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

    /**
     * The files with changes in git that Catenary did not write (at open, and for the files read again by the watcher): their writes
     * are not committed, so that a commit never takes changes of the user. Outside a repository: one warning.
     */
    async recordUncommitted(reloaded: string[] = []): Promise<void> {
        const changes = await gitChanges(this.folder);
        if (!changes.ok && !changes.repo) {
            this.note('not committed: workspace is not a git repository');
            return;
        }
        // No status (for example a locked or damaged index): no auto-commit at all, but the workspace opens.
        if (!changes.ok) {
            this.note(`not committed: git status failed (${changes.error})`);
            this.uncommitted = new Set([...this.modelFiles.keys()].map(f => pathKey(f)));
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
            this.note(`not committed: ${portableRelative(this.folder, file)} has changes that are not committed`);
            return false;
        });
    }

    protected note(text: string): void {
        this.options.note(text);
    }
}

/**
 * Create a workspace file with the placement (`defaultPlacement`, changed by `placement`: "near" or a path relative to the folder),
 * an empty file for each file of the placement (an existing one is used as it is) and views/main.view.trig with one empty view "Main".
 * Returns the absolute path of the workspace file.
 */
export async function createWorkspace(workspacePath: string, placement: Partial<Placement> = {}): Promise<{ error: string } | { file: string }> {
        workspacePath = absolutePath(workspacePath);
        const folder = path.dirname(workspacePath);
        const chosen = { ...defaultPlacement(workspacePath) };
        for (const k of PLACE_KINDS) {
            const v = placement[k];
            if (v === undefined) continue;
            if (v === NEAR) { chosen[k] = NEAR; continue; }
            const file = path.resolve(folder, v);
            const problem = !isInside(folder, file) ? `${v}: the file must be in the folder of the workspace file.` : writeProblem(file);
            if (problem) return { error: problem };
            chosen[k] = file;
        }
        const view = rdf.namedNode(mint('Main'));
        const viewQuads = [rdf.quad(view, P.type, V.View, view), rdf.quad(view, P.label, rdf.literal('Main'), view)];
        const manifest: Manifest = { placement: chosen, exclude: [], imported: [], prefixes: { ...DEFAULT_PREFIXES } };
        const viewFile = path.join(defaultViewsFolder(workspacePath), `main${VIEW_EXT}`);
        try {
            await fs.writeFile(workspacePath, await writeTrig(manifestQuads(manifest, workspacePath)), { flag: 'wx' });
            for (const file of new Set(PLACE_KINDS.map(k => chosen[k]).filter(f => f !== NEAR))) {
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(file, await serializeRdf([], file), { flag: 'wx' }).catch(e => {
                    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
                });
            }
            await fs.mkdir(path.dirname(viewFile), { recursive: true });
            await fs.writeFile(viewFile, await serializeRdf(viewQuads, viewFile), { flag: 'wx' });
        } catch (e) {
            return { error: `Cannot create ${workspacePath}: ${(e as Error).message}` };
        }
    return { file: workspacePath };
}

const EMPTY = canonical([]);


const toTriple = (q: Quad) => rdf.quad(q.subject, q.predicate, q.object);

interface WorkspaceFile {
    path: string;
    /** Canonical form of the saved manifest. Undefined: not saved at this path. */
    saved?: string;
    /** The text that Catenary last read or wrote. */
    text?: string;
}

/** A view file. `saved`: canonical form of the saved file; undefined: not on disk. */
interface ViewFile extends OnDisk {
    path: string;
    saved?: string;
    /** Blank nodes in the text on disk (0 after a write). */
    blanks?: number;
}

interface Canonical { workspace: string; files: Map<string, string>; views: Map<string, string> }

/** What Catenary last read from or wrote to a file: its text and its triples. The next write patches that text (text-patch.ts). No text: the file is not on disk yet. */
interface OnDisk {
    text?: string;
    triples?: Quad[];
}

/** A model file that is not a view. `saved`: canonical form of the saved file; undefined: not on disk. */
interface ModelFile extends OnDisk {
    path: string;
    saved?: string;
    error?: string;
    /** Blank nodes in the text on disk (0 after a write). */
    blanks?: number;
}

const unwrittenBlankNote = (file: string) =>
    `${path.basename(file)}: Catenary does not write this file, so its blank nodes get new IRIs at each read. Statements in other files about them are lost at the next read.`;

const skolemNote = (file: string, count: number) =>
    `${path.basename(file)}: ${count} blank node${count === 1 ? '' : 's'} replaced by IRIs (Catenary has no blank nodes); the file is changed until the next save writes them`;


/** The text reads as `triples`. */
/** `text` reads back as the triples whose canonical form is `expected`. */
async function sameTriples(text: string, file: string, expected: string): Promise<boolean> {
    try {
        return canonical((await parseRdf(text, file)).map(toTriple)) === expected;
    } catch {
        return false;
    }
}

async function readText(file: string): Promise<string> {
    try {
        return await fs.readFile(file, 'utf8');
    } catch (e) {
        throw new Error(`Cannot read ${file}: ${(e as Error).message}`);
    }
}

/** A workspace file (TriG): the manifest graph only. Other graphs (views of the old format) are refused. */
async function readWorkspace(file: string): Promise<{ manifest: Quad[]; warnings: string[]; text: string }> {
    const text = await readText(file);
    let parsed;
    try {
        parsed = await parseTrig(text);
    } catch (e) {
        throw new Error(`Cannot parse ${path.basename(file)}: ${(e as Error).message}`);
    }
    const other = new Set(parsed.quads.filter(q => q.graph.value !== MANIFEST_GRAPH).map(q => q.graph.value));
    if (other.size) throw new Error(`${path.basename(file)} has graphs other than the manifest (${[...other].slice(0, 3).join(', ')}${other.size > 3 ? ', …' : ''}). Views are view files now (*.view.trig).`);
    const { quads, count } = skolemize(parsed.quads);
    return { manifest: quads, warnings: count ? [skolemNote(file, count)] : [], text };
}

/** A model file read: a view (one view:View IRI), another file, or an error. Triples with blank node labels unique in the store. */
/** `noWrite`: why Catenary reads the file but does not write it. */
type FileRead = { kind: 'view'; path: string; view: string; triples: Quad[]; text: string; warnings: string[]; noWrite?: string }
    | { kind: 'model'; path: string; triples: Quad[]; text: string; warnings: string[]; noWrite?: string }
    | { kind: 'error'; path: string; error: string };

/** Until n3 reads annotations correctly: a file with the annotation syntax is read only (a write could remove statements that the read lost). */
const NO_WRITE_ANNOTATION = 'has RDF 1.2 annotation syntax ({| … |}); the reader (n3 2.7.12) can lose statements after it (rdfjs/N3.js #677, #673). Read only: Catenary does not write this file.';

/**
 * The views that RDF quads declare: the subjects of `rdf:type view:View`, in any graph (a SPARQL query on the quads of one file).
 * A file that declares a view is a view file, whatever its name.
 */
export function declaredViews(quads: Quad[]): string[] {
    if (!quads.some(q => q.object.equals(V.View))) return [];
    const rows = new OxigraphStore(quads).select(`PREFIX rdf: <${NS.rdf}> PREFIX view: <${NS.view}>
        SELECT DISTINCT ?view WHERE { { ?view rdf:type view:View } UNION { GRAPH ?g { ?view rdf:type view:View } } }`);
    return rows.map(r => r.view.value).sort(cmp);
}

/**
 * What a file holds that Catenary edits, from its content (not its name): the manifest graph (a workspace file), and the views that
 * it declares (`declaredViews`), with their labels. `viewFile`: a valid view file. `error`: the file is not RDF that Catenary reads.
 */
export async function fileContent(file: string): Promise<{ workspace: boolean; views: { iri: string; label: string }[]; viewFile: boolean; error?: string }> {
    let quads: Quad[];
    try {
        quads = await parseRdf(await readText(file), file);
    } catch (e) {
        return { workspace: false, views: [], viewFile: false, error: (e as Error).message };
    }
    const label = (iri: string) => quads.find(q => q.subject.value === iri && q.predicate.equals(P.label) && q.object.termType === 'Literal')?.object.value ?? iri;
    const views = declaredViews(quads).map(iri => ({ iri, label: label(iri) }));
    // viewFile: a view file that the read accepts (viewProblem).
    return { workspace: quads.some(q => q.graph.value === MANIFEST_GRAPH), views, viewFile: views.length > 0 && !viewProblem(quads) };
}

/**
 * Read one model file. Statements in named graphs are merged, with a warning. A file that declares a view (`declaredViews`), or a
 * `*.view.trig` file, is a view file: see `viewProblem`.
 */
async function readModelFile(file: string): Promise<FileRead> {
    let triples: Quad[], text: string;
    try {
        text = await readText(file);
        const quads = await parseRdf(text, file);
        triples = quads.map(toTriple);
        const noWrite = /\.(ttl|trig)$/i.test(file) && await hasAnnotation(text) ? NO_WRITE_ANNOTATION : undefined;
        if (isViewFile(file) || declaredViews(quads).length) {
            if (!/\.trig$/i.test(file)) return { kind: 'error', path: file, error: 'a view must be in a TriG file, in a graph named by the view IRI.' };
            const problem = viewProblem(quads);
            if (problem) return { kind: 'error', path: file, error: problem };
            return { kind: 'view', path: file, view: quads[0].graph.value, triples, text, warnings: [], noWrite };
        }
        const named = quads.filter(q => q.graph.termType !== 'DefaultGraph').length;
        const warnings = named ? [`${path.basename(file)}: ${named} statements in named graphs are read without the graph names; a write writes them so.`] : [];
        return { kind: 'model', path: file, triples, text, warnings, noWrite };
    } catch (e) {
        return { kind: 'error', path: file, error: (e as Error).message };
    }
}

/**
 * Why the quads of a view file are not a view, or undefined. A view file has one named graph `G` and no statements outside it; `G`
 * is the only view:View. Each placement has one `view:view G`. A view places an element (view:element) or a triple (rdf:reifies) once.
 */
export function viewProblem(quads: Quad[]): string | undefined {
    const graphs = rdf.termSet(quads.map(q => q.graph));
    if (graphs.size !== 1 || quads[0].graph.termType !== 'NamedNode') return `a view file has one named graph, the view; it has ${graphs.size} graph(s)${[...graphs].some(g => g.termType === 'DefaultGraph') ? ', with the default graph' : ''}`;
    const g = quads[0].graph;
    const views = rdf.termSet(quads.filter(q => q.predicate.equals(P.type) && q.object.equals(V.View)).map(q => q.subject));
    if (views.size !== 1 || ![...views][0].equals(g)) return `the graph <${g.value}> must contain exactly one view:View, <${g.value}> itself; found ${[...views].map(v => `<${v.value}>`).join(', ') || 'none'}`;
    const placed = new Map<string, string>();
    for (const p of quads.filter(q => q.predicate.equals(P.type) && q.object.equals(V.Placement)).map(q => q.subject)) {
        const name = `<${p.value}>`;
        const of = quads.filter(q => q.subject.equals(p) && q.predicate.equals(V.view)).map(q => q.object);
        if (of.length !== 1 || !of[0].equals(g)) return `${name} needs one view:view <${g.value}>; it has ${of.map(o => `<${o.value}>`).join(', ') || 'none'}`;
        for (const q of quads.filter(q => q.subject.equals(p) && (q.predicate.equals(V.element) || q.predicate.equals(P.reifies)))) {
            const k = termKey(q.object), other = placed.get(k);
            if (other) return `${other} and ${name} place the same ${q.object.termType === 'Quad' ? 'triple' : 'element'}; a view places it once`;
            placed.set(k, name);
        }
    }
    return undefined;
}

const SH_TYPES = new Set(['NodeShape', 'PropertyShape', 'Shape'].map(t => NS.sh + t));

/**
 * The subjects of the shapes of a file (termKey): subjects with a statement in the sh: namespace (a predicate, or rdf:type sh:…), and
 * the nodes below them that were blank nodes in a file (skolem IRIs: nested shapes, paths) and the RDF list cells below them.
 */
function shapePart(quads: Quad[]): Set<string> {
    const bySubject = new Map<string, Quad[]>();
    for (const q of quads) (bySubject.get(termKey(q.subject)) ?? bySubject.set(termKey(q.subject), []).get(termKey(q.subject))!).push(q);
    const out = new Set<string>();
    const isCell = (k: string) => (bySubject.get(k) ?? []).some(q => q.predicate.value === NS.rdf + 'first');
    const visit = (k: string) => {
        if (out.has(k)) return;
        out.add(k);
        for (const q of bySubject.get(k) ?? []) {
            const o = termKey(q.object);
            // A nested node, or an RDF list cell (sh:or, sh:in).
            if (isSkolem(q.object) || (q.object.termType === 'NamedNode' && isCell(o))) visit(o);
        }
    };
    for (const [k, qs] of bySubject) {
        if (qs.some(q => q.predicate.value.startsWith(NS.sh) || (q.predicate.equals(P.type) && SH_TYPES.has(q.object.value)))) visit(k);
    }
    // A list cell that no shape refers to (left by earlier saves) whose item or next cell is shape content: shape content too.
    for (let changed = true; changed;) {
        changed = false;
        for (const [k, qs] of bySubject) {
            if (out.has(k) || !isCell(k)) continue;
            if (qs.some(q => (q.predicate.value === NS.rdf + 'first' || q.predicate.value === NS.rdf + 'rest') && out.has(termKey(q.object)))) { visit(k); changed = true; }
        }
    }
    return out;
}

