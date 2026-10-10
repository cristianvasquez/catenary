// The loader (ADR 0003): reads the workspace file and the model files, and puts a file read into its graphs of the store, through
// the patch path of ModelGraph. A view file: its view graph. Another file: its shapes (shapePart) to the shapes graph of the file, the
// other statements to its data graph. Blank nodes get IRIs (skolem.ts); a save writes the IRIs.

import { DEFAULT_PREFIXES, NS, setPrefixes } from '@catenary/model';
import type { Quad } from '@rdfjs/types';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { OxigraphStore, absolutePath, hasAnnotation, knownPath, portableRelative } from 'rdf-files';
import { MANIFEST_GRAPH, NEAR, WORKSPACE_FILE, isViewFile, listModelFiles, parseRdf, readManifest, workspaceFileOf } from './files';
import { ModelGraph, P, V, cmp, dataGraphIri, fileGraphIri } from './graph';
import { FileRead, PLACE_KINDS, Settings } from './settings';
import { isSkolem, skolemize } from './skolem';
import { rdf, termKey } from './terms';
import { canonical, parseTrig } from './trig';

/**
 * Read a workspace file and its model files into `graph`. `ofFolder`: the folder was given; a workspace file that is not on disk is
 * the default manifest. Sets the prefix table of the read models (before the files are read: the shapes read model compacts IRIs with
 * it).
 */
export async function openWorkspace(graph: ModelGraph, primaryPath: string, ofFolder: boolean): Promise<{ error: string } | { settings: Settings; loader: Loader; warnings: string[] }> {
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

    const settings = new Settings(graph, primaryPath, manifest, primary.text);
    const loader = new Loader(graph, settings);
    graph.update(() => {
        for (const r of reads) {
            if (typeof r === 'string') warnings.push(r);
            else loader.mount(r, warnings);
        }
        settings.syncShapesTarget();
    });
    return { settings, loader, warnings };
}

/** Resolve a folder, workspace file or recent entry. The content decides, not the name. */
export async function resolveOpenTarget(workspacePath: string): Promise<{ file: string; ofFolder: boolean } | { error: string }> {
    let given = absolutePath(workspacePath);
    if (path.basename(given) === WORKSPACE_FILE && !existsSync(given) && existsSync(path.dirname(given))) given = path.dirname(given);
    const target = await workspaceFileOf(given);
    if ('error' in target) return { error: target.error };
    const content = existsSync(target.file) ? await fileContent(target.file) : undefined;
    if (content?.viewFile && !content.workspace) return { error: `${path.basename(target.file)} is a view file. Open its workspace, then open the view.` };
    return { file: target.file, ofFolder: target.file !== given };
}

/** Source reads precede all import changes. */
export interface ImportRead { name: string; text: string; quads?: Quad[]; source: string; inPlace?: string }

export async function readImportSources(sources: string[], knownFile: (file: string) => string | undefined): Promise<{ reads: ImportRead[] } | { error: string }> {
    const reads: ImportRead[] = [];
    for (const source of sources) {
        const name = path.basename(source);
        const inPlace = knownFile(path.resolve(source));
        try {
            const text = await fs.readFile(source, 'utf8');
            const quads = inPlace ? undefined : await parseRdf(text, source);
            if (quads && !quads.length) return { error: `${name}: not imported: the file has no statements.` };
            reads.push({ name, text, quads, source, inPlace });
        } catch (e) {
            return { error: `${name}: not imported: ${(e as Error).message}` };
        }
    }
    return { reads };
}

/** Puts file reads into the store and takes files out of it. */
export class Loader {
    constructor(protected readonly graph: ModelGraph, protected readonly settings: Settings) {}

    /** Read one model file (`readModelFile`). */
    read(file: string): Promise<FileRead> {
        return readModelFile(file);
    }

    /**
     * Put a file read into the store. A view: its graph (false when another file has the view). Another file: its shapes to the graph
     * of the file, the rest to its data graph. Blank nodes get IRIs (skolem.ts); a save writes the IRIs.
     */
    mount(r: FileRead, notes: string[]): boolean {
        let mounted = false;
        this.graph.update(() => { mounted = this.mountNow(r, notes); });
        return mounted;
    }

    protected mountNow(r: FileRead, notes: string[]): boolean {
        this.graph.invalidate({ persisted: true, data: true });
        const name = portableRelative(this.settings.folder, r.path);
        if (r.kind === 'error') {
            this.settings.modelFiles.set(r.path, { path: r.path, error: r.error });
            notes.push(`${name}: not read: ${r.error}`);
            return false;
        }
        notes.push(...r.warnings);
        if (r.noWrite) { this.settings.noWrite.set(r.path, r.noWrite); notes.push(`${name}: ${r.noWrite}`); } else this.settings.noWrite.delete(r.path);
        if (r.kind === 'view') {
            if (this.graph.isView(rdf.namedNode(r.view))) { notes.push(`${name}: not read: the view ${r.view} is in another file too.`); return false; }
            const read = r.triples.map(q => rdf.quad(q.subject, q.predicate, q.object, rdf.namedNode(r.view)));
            const { quads, count } = skolemize(read);
            // A file with blank nodes differs from its saved form: the next save writes the IRIs (not a file that Catenary does not write).
            const keep = !this.settings.writeProblemOf(r.path);
            if (count) notes.push(keep ? skolemNote(r.path, count) : unwrittenBlankNote(r.path));
            for (const q of quads) this.graph.add(q.subject, q.predicate, q.object, q.graph);
            this.settings.viewFiles.set(r.view, { path: r.path, saved: canonical((count && keep ? read : quads).map(toTriple)), text: r.text, triples: quads.map(toTriple), blanks: count });
            return true;
        }
        const { quads, count } = skolemize(r.triples);
        // A file that Catenary does not write keeps its blank nodes on disk: its saved form is the read with IRIs.
        const keep = !this.settings.writeProblemOf(r.path);
        if (count) notes.push(keep ? skolemNote(r.path, count) : unwrittenBlankNote(r.path));
        const shapes = shapePart(quads), graph = rdf.namedNode(fileGraphIri(r.path)), data = rdf.namedNode(dataGraphIri(r.path));
        this.graph.addDataGraph(data);
        for (const q of quads) {
            if (shapes.has(termKey(q.subject))) { this.graph.add(q.subject, q.predicate, q.object, graph); continue; }
            this.graph.add(q.subject, q.predicate, q.object, data);
        }
        this.settings.modelFiles.set(r.path, { path: r.path, saved: canonical(count && keep ? r.triples : quads), text: r.text, triples: quads, blanks: count });
        return true;
    }

    /** Take a file out of the store: a view file its view; a model file its shapes graph and its statements of the model graph. */
    unmount(file: string): void {
        this.graph.update(() => this.unmountNow(file));
    }

    protected unmountNow(file: string): void {
        this.graph.invalidate({ persisted: true, data: true });
        for (const [iri, f] of [...this.settings.viewFiles]) {
            if (f.path !== file) continue;
            for (const q of this.graph.match(null, null, null, rdf.namedNode(iri))) this.graph.remove(q);
            this.settings.viewFiles.delete(iri);
        }
        if (!this.settings.modelFiles.has(file)) return;
        for (const q of this.graph.match(null, null, null, rdf.namedNode(fileGraphIri(file)))) this.graph.remove(q);
        for (const q of this.graph.match(null, null, null, rdf.namedNode(dataGraphIri(file)))) this.graph.remove(q);
        this.settings.modelFiles.delete(file);
    }
}

const unwrittenBlankNote = (file: string) =>
    `${path.basename(file)}: Catenary does not write this file, so its blank nodes get new IRIs at each read. Statements in other files about them are lost at the next read.`;

const skolemNote = (file: string, count: number) =>
    `${path.basename(file)}: ${count} blank node${count === 1 ? '' : 's'} replaced by IRIs (Catenary has no blank nodes); the file is changed until the next save writes them`;

const toTriple = (q: Quad) => rdf.quad(q.subject, q.predicate, q.object);

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
export function shapePart(quads: Quad[]): Set<string> {
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
