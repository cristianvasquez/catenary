// The files of a workspace: the manifest of the workspace file, and the model files (ADR 0004). RDF formats: rdf-files.
// Workspace file (TriG): the manifest graph only. Model files: every other RDF file of the folder of the workspace file and its
// subfolders; a file that declares a view:View (any name; `*.view.trig` by default) is a view. Manifest paths are relative to the workspace file.

import { NS } from '@catenary/model';
import type { Quad } from '@rdfjs/types';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PathApi, listRdfFiles, pathKey, portableRelative, resolveStored, serializeRdf as serialize } from 'rdf-files';
import { PREFIXES, rdf } from './terms';

export { globRegExp, parseRdf, writeProblem } from 'rdf-files';

export const MANIFEST_GRAPH = 'urn:name:workspace';

export const WS = {
    Workspace: rdf.namedNode(NS.ws + 'Workspace'),
    /** The file for new subjects when "near" finds no file (see Placement). */
    defaultFile: rdf.namedNode(NS.ws + 'defaultFile'),
    /** Where new shapes, SKOS resources and other subjects go: a file path, or "near" (near their kind). Legacy: "default". */
    placeShapes: rdf.namedNode(NS.ws + 'placeShapes'),
    placeConcepts: rdf.namedNode(NS.ws + 'placeConcepts'),
    placeInstances: rdf.namedNode(NS.ws + 'placeInstances'),
    /** A glob (relative to the workspace folder) of files that are not model files. */
    exclude: rdf.namedNode(NS.ws + 'exclude'),
    /** A glob (relative to the workspace folder) of imported model files: Catenary reads them and does not change them (read only). */
    imported: rdf.namedNode(NS.ws + 'imported'),
    /** Legacy name of ws:imported (read, not written). */
    protect: rdf.namedNode(NS.ws + 'protect'),
    /** The views of the last HTML export, in order: an RDF list of view IRIs. */
    exportViews: rdf.namedNode(NS.ws + 'exportViews')
};

const PLACE_PREDICATES = { shapes: WS.placeShapes, concepts: WS.placeConcepts, instances: WS.placeInstances };

const LIST = { first: rdf.namedNode(NS.rdf + 'first'), rest: rdf.namedNode(NS.rdf + 'rest'), nil: rdf.namedNode(NS.rdf + 'nil') };

/** SHACL prefix declarations of the manifest: <urn:name:workspace> sh:declare [ sh:prefix "dcat" ; sh:namespace "…"^^xsd:anyURI ]. */
const DECLARE = {
    declare: rdf.namedNode(NS.sh + 'declare'),
    PrefixDeclaration: rdf.namedNode(NS.sh + 'PrefixDeclaration'),
    prefix: rdf.namedNode(NS.sh + 'prefix'),
    namespace: rdf.namedNode(NS.sh + 'namespace'),
    anyURI: rdf.namedNode(NS.xsd + 'anyURI')
};

/** Write triples (default graph) in the format of the file, with the prefixes of the workspace. */
export const serializeRdf = (quads: Iterable<Quad>, file: string): Promise<string> => serialize(quads, file, PREFIXES);

/** Where new subjects of a kind go: an absolute file path, or `NEAR` (near their kind). */
export type Place = string;
export const NEAR = 'near';
/** Where new subjects go, by kind. `instances`: every subject that is not a shape or a SKOS resource. */
export interface Placement { shapes: Place; concepts: Place; instances: Place }
const PLACE_KINDS = ['shapes', 'concepts', 'instances'] as const;

/**
 * The placement of a new workspace `<name>.trig`: shapes in `<name>.shapes.ttl`, SKOS resources in `<name>.skos.ttl`, other subjects
 * near their kind.
 */
export function defaultPlacement(workspaceFile: string): Placement {
    const base = workspaceFile.replace(/\.trig$/i, '');
    return { shapes: `${base}.shapes.ttl`, concepts: `${base}.skos.ttl`, instances: NEAR };
}

/**
 * The placement of a kind without a value in the manifest (a manifest before per-kind files, or no manifest): with `ws:defaultFile`,
 * shapes in that file and other subjects near; else all near. "Near" without a near file uses the default file.
 */
const unsetPlacement = (defaultFile?: string): Placement => ({ shapes: defaultFile ?? NEAR, concepts: NEAR, instances: NEAR });

/** The settings that the manifest of the workspace file stores. Absolute paths. */
export interface Manifest {
    /** The file for new subjects when "near" finds no file. Undefined: not set. */
    defaultFile?: string;
    placement: Placement;
    /** Globs, relative to the workspace folder. */
    exclude: string[];
    /** Globs of imported files, relative to the workspace folder. */
    imported: string[];
    /** Prefix table (prefix -> namespace). Undefined: the file declares none; the defaults apply. */
    prefixes?: Record<string, string>;
    /** View IRIs of the last HTML export, in export order. Undefined: none stored. */
    exportViews?: string[];
}

export { VIEW_EXT, isViewFile } from '@catenary/model';

/** The folder of new view files: `views` next to the workspace file. */
export const defaultViewsFolder = (workspaceFile: string) => path.join(path.dirname(workspaceFile), 'views');

/** A TriG file with the workspace namespace in its text: a workspace file (not a model file). */
const isWorkspaceFile = async (file: string) => file.endsWith('.trig') && (await fs.readFile(file, 'utf8').catch(() => '')).includes(NS.ws);

/** The name of the workspace file of a folder that has none: the folder opens with the default settings, and a settings change writes it. */
export const WORKSPACE_FILE = 'workspace.trig';

/** The workspace files of a folder: its `workspace.trig` when it has one, else the TriG files with the workspace namespace. */
async function workspaceFilesIn(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some(e => e.name === WORKSPACE_FILE)) return [path.join(dir, WORKSPACE_FILE)];
    const found: string[] = [];
    for (const e of entries) if (e.isFile() && await isWorkspaceFile(path.join(dir, e.name))) found.push(path.join(dir, e.name));
    return found.sort();
}

/**
 * The workspace file to open for a path. A file: the file. A folder: its `workspace.trig`, else its only workspace file, else
 * `workspace.trig` that is not on disk (the folder with the default settings). An error when the folder has several workspace files.
 */
export async function workspaceFileOf(p: string): Promise<{ file: string } | { error: string }> {
    if (!(await fs.stat(p).catch(() => undefined))?.isDirectory()) return { file: p };
    const found = await workspaceFilesIn(p);
    if (found.length > 1) return { error: `${p} has ${found.length} workspace files (${found.map(f => path.basename(f)).join(', ')}): open one of them.` };
    return { file: found[0] ?? path.join(p, WORKSPACE_FILE) };
}

/** The workspace file of the nearest folder that contains `file` and has exactly one workspace file; undefined: none. */
export async function enclosingWorkspace(file: string): Promise<string | undefined> {
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
        const found = (await workspaceFilesIn(dir)).filter(f => pathKey(f) !== pathKey(file));
        if (found.length === 1) return found[0];
        if (found.length > 1 || path.dirname(dir) === dir) return undefined;
    }
}

/**
 * The model files of a workspace (ADR 0004): the RDF files of the folder of the workspace file and its subfolders, in path order. Not:
 * hidden files and folders, `*.bak`, `node_modules`, workspace files (a manifest graph), a subfolder with its own workspace file (a
 * nested workspace), and the paths that an `exclude` glob matches.
 */
export async function listModelFiles(workspaceFile: string, exclude: string[]): Promise<string[]> {
    return listRdfFiles(path.dirname(workspaceFile), {
        exclude,
        // A nested workspace (a workspace file in a subfolder): not this one.
        check: async file => pathKey(file) === pathKey(workspaceFile) ? 'skip' : await isWorkspaceFile(file) ? 'stop' : undefined
    });
}

/** Read the manifest graph. Paths are resolved against the directory of the workspace file (`/` or `\` as separator). */
export function readManifest(quads: Quad[], workspaceFile: string, platform: PathApi = path): Manifest {
    const dir = platform.dirname(workspaceFile);
    const values = (p: Quad['predicate']) => quads.filter(q => q.predicate.equals(p) && q.object.termType === 'Literal')
        .map(q => resolveStored(dir, q.object.value, platform)).sort();
    const literals = (p: Quad['predicate']) => quads.filter(q => q.predicate.equals(p) && q.object.termType === 'Literal').map(q => q.object.value);
    const defaultFile = values(WS.defaultFile)[0];
    const unset = unsetPlacement(defaultFile);
    // "near", a path, or the legacy "default" (the default file; without one: near, which uses the proposed default file).
    const place = (p: Quad['predicate'], k: keyof Placement): Place => {
        const v = literals(p)[0];
        if (v === NEAR || (v === 'default' && !defaultFile)) return NEAR;
        if (v === 'default') return defaultFile!;
        return v ? resolveStored(dir, v, platform) : unset[k];
    };
    const prefixes: Record<string, string> = {};
    for (const d of quads.filter(q => q.predicate.equals(DECLARE.declare))) {
        const one = (p: Quad['predicate']) => quads.find(q => q.subject.equals(d.object) && q.predicate.equals(p))?.object.value;
        const prefix = one(DECLARE.prefix), ns = one(DECLARE.namespace);
        if (prefix !== undefined && ns) prefixes[prefix] = ns;
    }
    // The first ws:exportViews list; IRI items only, a cycle or a broken list ends it.
    const exportViews: string[] = [];
    const head = quads.find(q => q.predicate.equals(WS.exportViews));
    for (let cell = head?.object, seen = new Set<string>(); cell && !cell.equals(LIST.nil) && !seen.has(cell.value);) {
        seen.add(cell.value);
        const item = quads.find(q => q.subject.equals(cell!) && q.predicate.equals(LIST.first))?.object;
        if (item?.termType === 'NamedNode') exportViews.push(item.value);
        cell = quads.find(q => q.subject.equals(cell!) && q.predicate.equals(LIST.rest))?.object;
    }
    return {
        ...(defaultFile ? { defaultFile } : {}),
        placement: { shapes: place(WS.placeShapes, 'shapes'), concepts: place(WS.placeConcepts, 'concepts'), instances: place(WS.placeInstances, 'instances') },
        exclude: literals(WS.exclude).sort(),
        imported: [...new Set([...literals(WS.imported), ...literals(WS.protect)])].sort(),
        ...(Object.keys(prefixes).length ? { prefixes } : {}), ...(head ? { exportViews } : {})
    };
}

/** The manifest graph, with paths relative to the directory of the workspace file, with `/` on every platform. */
export function manifestQuads(m: Manifest, workspaceFile: string, platform: PathApi = path): Quad[] {
    const dir = platform.dirname(workspaceFile);
    const g = rdf.namedNode(MANIFEST_GRAPH);
    const rel = (file: string) => rdf.literal(portableRelative(dir, file, platform));
    // Nodes named after the manifest: `urn:name:workspace-declare-<prefix>`, `urn:name:workspace-exportViews-<n>`.
    return [
        rdf.quad(g, rdf.namedNode(NS.rdf + 'type'), WS.Workspace, g),
        ...(m.defaultFile ? [rdf.quad(g, WS.defaultFile, rel(m.defaultFile), g)] : []),
        // Every kind: a reader sees the placement without the defaults of this program.
        ...PLACE_KINDS.map(k => rdf.quad(g, PLACE_PREDICATES[k], m.placement[k] === NEAR ? rdf.literal(NEAR) : rel(m.placement[k]), g)),
        ...m.exclude.map(e => rdf.quad(g, WS.exclude, rdf.literal(e), g)),
        ...m.imported.map(e => rdf.quad(g, WS.imported, rdf.literal(e), g)),
        ...Object.entries(m.prefixes ?? {}).sort(([a], [b]) => a.localeCompare(b)).flatMap(([prefix, ns]) => {
            const d = rdf.namedNode(`${MANIFEST_GRAPH}-declare-${prefix}`);
            return [
                rdf.quad(g, DECLARE.declare, d, g),
                rdf.quad(d, rdf.namedNode(NS.rdf + 'type'), DECLARE.PrefixDeclaration, g),
                rdf.quad(d, DECLARE.prefix, rdf.literal(prefix), g),
                rdf.quad(d, DECLARE.namespace, rdf.literal(ns, DECLARE.anyURI), g)
            ];
        }),
        ...(m.exportViews ? listQuads(g, WS.exportViews, m.exportViews.map(v => rdf.namedNode(v))) : [])
    ];
}

/** (s p ( items )) in graph g: an RDF list, cells `<g>-<local name of p>-<n>`. */
function listQuads(g: Quad['graph'], p: Quad['predicate'], items: Quad['object'][]): Quad[] {
    const cells = items.map((_, i) => rdf.namedNode(`${g.value}-${p.value.replace(/^.*[#/]/, '')}-${i + 1}`));
    return [
        rdf.quad(g as Quad['subject'], p, cells[0] ?? LIST.nil, g),
        ...cells.flatMap((c, i) => [rdf.quad(c, LIST.first, items[i], g), rdf.quad(c, LIST.rest, cells[i + 1] ?? LIST.nil, g)])
    ];
}

/** The folder of imported files, relative to the workspace folder. The import marks each file that it writes there as imported. */
export const IMPORT_FOLDER = 'imported';

/**
 * The prefix declarations in the text of an RDF file (prefix -> namespace), in the order of the text: `@prefix` and `PREFIX` of
 * Turtle, TriG and N3, `xmlns:` of RDF/XML, the string terms of a JSON-LD `@context` object. A text search, not a parse.
 */
export function declaredPrefixes(text: string, file: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (/\.(jsonld|json)$/i.test(file)) {
        try {
            const contexts = [JSON.parse(text)].flat().map(d => d?.['@context']).flat();
            for (const c of contexts) {
                if (!c || typeof c !== 'object') continue;
                for (const [p, ns] of Object.entries(c)) if (typeof ns === 'string' && !p.startsWith('@') && /[#/]$/.test(ns)) out[p] = ns;
            }
        } catch {
            // Not JSON: the read reports it.
        }
        return out;
    }
    const pattern = /\.(rdf|owl|xml)$/i.test(file) ? /\bxmlns:([A-Za-z][\w.-]*)\s*=\s*["']([^"']+)["']/g : /(?:@prefix|\bPREFIX)\s+([A-Za-z][\w.-]*)?:\s*<([^>]*)>/gi;
    for (const m of text.matchAll(pattern)) if (m[2]) out[m[1] ?? ''] = m[2];
    return out;
}

/**
 * 1-based line of the first statement about `iri` in an RDF text: the first line that starts with the IRI (subject of a Turtle, TriG
 * or N-Triples statement), else the first line that contains it. Forms: <iri>, prefix:local with a prefix of the file, "iri" (JSON-LD).
 * A text search, not a parse: a relative IRI or an escaped local name is not found. Undefined: not found.
 */
export function sourceLine(text: string, iri: string): number | undefined {
    const forms = [`<${iri}>`, `"${iri}"`];
    for (const m of text.matchAll(/(?:@prefix|\bPREFIX)\s+([A-Za-z][\w.-]*)?:\s*<([^>]*)>/gi)) {
        const local = iri.slice(m[2].length);
        if (m[2] && iri.startsWith(m[2]) && /^[\w-][\w.%-]*$/.test(local)) forms.push(`${m[1] ?? ''}:${local}`);
    }
    const name = /[\w.%:-]/;
    /** Index of `form` in `line` as one token, or -1. */
    const find = (line: string, form: string): number => {
        for (let i = line.indexOf(form); i >= 0; i = line.indexOf(form, i + 1)) {
            const before = line[i - 1], after = line[i + form.length];
            if (form.startsWith('<') || form.startsWith('"')) return i;
            if ((!before || !name.test(before)) && (!after || !name.test(after) || (after === '.' && !name.test(line[i + form.length + 1] ?? '')))) return i;
        }
        return -1;
    };
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
        const start = line.length - line.trimStart().length;
        if (forms.some(f => find(line, f) === start)) return i + 1;
    }
    for (const [i, line] of lines.entries()) if (forms.some(f => find(line, f) >= 0)) return i + 1;
    return undefined;
}
