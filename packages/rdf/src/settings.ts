// The settings of an open workspace (ADR 0003, ADR 0004): the workspace file (the manifest), which files belong to the workspace
// (file membership), what Catenary does not write, the imported globs, and which file holds each statement. The other sync modules
// (loader.ts, reconciler.ts, placement.ts, saver.ts, validation-data.ts) read and update this state; none of them imports another.
// ModelStore, the coordinator, creates the store and wires them.

import { DEFAULT_PREFIXES, FileKind, NS, VALIDATION_MODES, ValidationMode, WorkspaceFiles } from '@catenary/model';
import type { Quad } from '@rdfjs/types';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { absolutePath, isInside, knownPath, pathKey, portableRelative } from 'rdf-files';
import { Manifest, NEAR, Placement, VIEW_EXT, defaultPlacement, defaultViewsFolder, globRegExp, manifestQuads, serializeRdf, writeProblem } from './files';
import { Change, ModelGraph, P, SKOS_TYPES, V, cmp, dataGraphIri, fileGraphIri, fileOfGraph, mint } from './graph';
import { elementTerm } from './ids';
import { rdf, termKey, tripleKey } from './terms';
import { canonical, writeTrig } from './trig';

export const PLACE_KINDS = ['shapes', 'concepts', 'instances'] as const;

/** What a file of the workspace saved, as `saved` of its record: the canonical form of the saved file and its parts. */
export interface Saved { workspace: boolean; files: Set<string>; views: Set<string>; deleted: string[] }

export class Settings {
    /** The workspace file: the manifest. */
    readonly workspace: WorkspaceFile;
    /** View graph IRI -> its view file. The entry of a deleted view stays until a save removes the file (an undo brings it back). */
    readonly viewFiles = new Map<string, ViewFile>();
    /** Folder of the view file of the view that the running `createView` makes (its `folder`); undefined: `views/`. */
    newViewFolder?: string;
    /** The view file of the view that the running `createView` makes (its `file`); undefined: a free name in `newViewFolder`. */
    newViewFile?: string;
    /** The model files that are not views, by path. Their shapes are in the shapes graph of the file, the rest in its data graph. */
    readonly modelFiles = new Map<string, ModelFile>();
    /** Files that Catenary reads but does not write (path -> why), besides the formats it does not write (`writeProblem`). */
    readonly noWrite = new Map<string, string>();
    /** Manifest settings: the file for new subjects (undefined: not set), the placement by kind, the exclude globs. */
    protected defaultFileSetting?: string;
    placement: Placement;
    exclude: string[];
    /** Globs of the imported files (manifest ws:imported): Catenary reads them and refuses each change of their statements. */
    protected imported: string[];
    /** What SHACL validation checks (manifest ws:validation). */
    validation: ValidationMode;
    /** Prefix table of the workspace file. Undefined: the file declares none (DEFAULT_PREFIXES apply, the file stays as it is). */
    prefixes?: Record<string, string>;
    /** The workspace file was removed or moved on disk: no watch, no reads, no writes until the next open. */
    gone = false;
    /** Another workspace was opened: a save of this one writes nothing. */
    retired = false;
    protected kindsCache?: { event: unknown; kinds: Map<string, Set<FileKind>> };

    constructor(readonly graph: ModelGraph, primaryPath: string, manifest: Manifest, text: string | undefined) {
        // Saved state in the form that a save writes: another spelling of the same manifest is not a change.
        this.workspace = { path: primaryPath, saved: canonical(manifestQuads(manifest, primaryPath)), text };
        this.defaultFileSetting = manifest.defaultFile;
        this.placement = manifest.placement;
        this.exclude = manifest.exclude;
        this.imported = manifest.imported;
        this.validation = manifest.validation ?? 'all';
        this.prefixes = manifest.prefixes;
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

    /** The files of the workspace and their state; `views`: the view ids of the read model; `saved`: what differs from the files (saver.ts). */
    info(views: string[], saved: Saved): WorkspaceFiles {
        const kinds = this.fileKinds();
        return {
            workspace: { path: this.workspace.path, dirty: saved.workspace, onDisk: this.workspace.text !== undefined },
            defaultFile: { path: this.defaultFile, set: this.defaultFileSetting !== undefined },
            placement: { ...this.placement },
            exclude: [...this.exclude],
            imported: [...this.imported],
            validation: this.validation,
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

    /** A concrete quad names its file. A logical data triple names each file graph that contains it. */
    filesOfQuad(q: Quad): string[] {
        if (q.graph.equals(this.graph.model)) return [...new Set(this.graph.dataGraphs().filter(g => this.graph.match(q.subject, q.predicate, q.object, g).length).map(g => fileOfGraph(g.value)))];
        if (this.graph.isDataGraph(q.graph) || this.graph.isShapesGraph(q.graph)) return [fileOfGraph(q.graph.value)];
        const f = this.viewFiles.get(q.graph.value)?.path;
        return f ? [f] : [];
    }

    /** What each model file contains: shapes (its graph has quads), concepts and instances (typed subjects of the model graph). */
    fileKinds(): Map<string, Set<FileKind>> {
        const event = this.graph.keys.data;
        if (this.kindsCache?.event === event) return this.kindsCache.kinds;
        const kinds = new Map<string, Set<FileKind>>();
        this.kindsCache = { event, kinds };
        const add = (file: string, k: FileKind) => (kinds.get(file) ?? kinds.set(file, new Set()).get(file)!).add(k);
        for (const f of this.modelFiles.keys()) if (this.graph.match(null, null, null, rdf.namedNode(fileGraphIri(f))).length) add(f, 'shapes');
        for (const q of this.graph.match(null, P.type, null, this.graph.model)) {
            const k: FileKind = SKOS_TYPES.some(t => t.equals(q.object)) ? 'concepts' : 'instances';
            for (const f of this.filesOfQuad(q)) add(f, k);
        }
        return kinds;
    }

    manifest(): Manifest {
        return {
            ...(this.defaultFileSetting ? { defaultFile: this.defaultFileSetting } : {}), placement: { ...this.placement }, exclude: [...this.exclude],
            imported: [...this.imported],
            ...(this.prefixes ? { prefixes: this.prefixes } : {}),
            ...(this.validation !== 'all' ? { validation: this.validation } : {})
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
    modelFile(file: string): ModelFile {
        let f = this.modelFiles.get(file);
        if (!f) this.modelFiles.set(file, f = { path: file });
        return f;
    }

    /** A file of the placement when Catenary can write it, else the default file. */
    placeFile(file: string | undefined): string {
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
        this.graph.setDataGraphs([...this.modelFiles.keys()].map(f => rdf.namedNode(dataGraphIri(f))));
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

    /** Undefined, or why Catenary does not write this file: its format (`writeProblem`), its content (`noWrite`), or an import mark (ws:imported). */
    writeProblemOf(file: string): string | undefined {
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
     * change. Placement runs first. A new statement about an imported subject goes to a writable file.
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

    /** The files of the data graphs that a committed patch touched are files of the workspace (a new file of a placement). */
    track(changes: readonly Change[]): void {
        for (const c of changes) if (this.graph.isDataGraph(c.quad.graph) && !c.quad.graph.equals(this.graph.model)) this.modelFile(fileOfGraph(c.quad.graph.value));
        this.graph.setDataGraphs([...this.modelFiles.keys()].map(f => rdf.namedNode(dataGraphIri(f))));
    }

    /** Refuse transfers to unknown, view, invalid or read-only files before changing anything. */
    transferProblem(files: string[]): string | undefined {
        for (const file of files) {
            const record = this.modelFiles.get(file);
            if (!record) return `${path.basename(file)} is not a model data file.`;
            const problem = record.error ?? this.writeProblemOf(file);
            if (problem) return problem;
        }
        return undefined;
    }

    /**
     * Check and apply settings of the manifest: the default file and the file of each kind (a model file, or a new RDF file in the
     * workspace folder; a kind: also "near"), the exclude globs, the imported globs (§2.6). `reread`: the exclude globs changed, so the
     * files must be read again. `saved`: what differs from the files (saver.ts).
     */
    applySettings(settings: { defaultFile?: string; placement?: Partial<Placement>; exclude?: string[]; imported?: string[]; validation?: ValidationMode }, saved: Saved): { error: string } | { reread: boolean } {
        if (settings.validation !== undefined && !VALIDATION_MODES.includes(settings.validation)) return { error: `Validation: "${settings.validation}" (use off, views or all).` };
        // Imported globs first: the files of new subjects are checked against the new globs. An error keeps the old globs.
        const was = this.imported;
        if (settings.imported) {
            const globs = [...new Set(settings.imported.map(g => g.trim()).filter(Boolean))];
            const problem = this.importedProblem(globs, saved);
            if (problem) return { error: problem };
            this.imported = globs;
        }
        const r = this.applyPlaces(settings);
        if ('error' in r) this.imported = was;
        else {
            if (settings.validation) this.validation = settings.validation;
            this.graph.invalidate({ persisted: true, data: true });
        }
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
    protected importedProblem(globs: string[], saved: Saved): string | undefined {
        const dirty = new Set([...saved.files, ...[...saved.views].map(v => this.viewFiles.get(v)?.path)]);
        for (const f of [...this.modelFiles.values(), ...this.viewFiles.values()]) {
            if (!this.isImported(f.path, globs) || this.isImported(f.path)) continue;
            const name = portableRelative(this.folder, f.path);
            if (dirty.has(f.path)) return `${name} has changes that are not written. Mark it as imported after the write.`;
            if (f.blanks) return `${name} has blank nodes, and Catenary does not write this file, so they cannot get IRIs. Import the file from outside the workspace folder: the import writes a Turtle copy with IRIs.`;
        }
        return undefined;
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

/** The workspace file. `saved`: canonical form of the saved manifest; undefined: not saved at this path. `text`: the text that Catenary last read or wrote. */
export interface WorkspaceFile {
    path: string;
    saved?: string;
    text?: string;
}

/** What Catenary last read from or wrote to a file: its text and its triples. The next write patches that text (text-patch.ts). No text: the file is not on disk yet. */
export interface OnDisk {
    text?: string;
    triples?: Quad[];
}

/** A view file. `saved`: canonical form of the saved file; undefined: not on disk. */
export interface ViewFile extends OnDisk {
    path: string;
    saved?: string;
    /** Blank nodes in the text on disk (0 after a write). */
    blanks?: number;
}

/** A model file that is not a view. `saved`: canonical form of the saved file; undefined: not on disk. */
export interface ModelFile extends OnDisk {
    path: string;
    saved?: string;
    error?: string;
    /** Blank nodes in the text on disk (0 after a write). */
    blanks?: number;
}

/** A model file read: a view (one view:View IRI), another file, or an error. `noWrite`: why Catenary reads the file but does not write it. */
export type FileRead = { kind: 'view'; path: string; view: string; triples: Quad[]; text: string; warnings: string[]; noWrite?: string }
    | { kind: 'model'; path: string; triples: Quad[]; text: string; warnings: string[]; noWrite?: string }
    | { kind: 'error'; path: string; error: string };
