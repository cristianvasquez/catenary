import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeCommand } from '../src/commands';
import { FILE_GRAPH_PREFIX, ModelGraph } from '../src/graph';
import type { NamedNode } from '@rdfjs/types';
import { Metamodel, metamodelFromQuads } from '../src/shapes';
import { Classes, Doc, EditCommand } from '@catenary/model';
import { project } from './project-full';
import type { ModelStore } from '../src/model-store';
import { parseTrig } from '../src/trig';
import { OxigraphStore } from 'rdf-files';
import { skolemize } from '../src/skolem';
import { rdf } from '../src/terms';

/** Metamodel of shapes in Turtle or TriG text (TriG is a superset; quads in named graphs count as shapes too). */
export async function parseShapes(text: string, source?: string): Promise<Metamodel> {
    return metamodelFromQuads(await rdf.io.dataset.fromText('application/trig', text), source);
}

export const SHAPES = readFileSync(new URL('./fixtures/shapes.ttl', import.meta.url), 'utf8');
/** The model graph and the view graphs in one TriG (the dataset in memory). */
export const MODEL = readFileSync(new URL('./fixtures/model.trig', import.meta.url), 'utf8');
/** The same content as files: workspace file (manifest), view files (views/) and data file. */
export const WORKSPACE = readFileSync(new URL('./fixtures/workspace.trig', import.meta.url), 'utf8');
/** The view files of the fixture workspace: file name -> text. */
export const VIEW_FILES: Record<string, string> = Object.fromEntries(readdirSync(new URL('./fixtures/views', import.meta.url))
    .map(f => [f, readFileSync(new URL('./fixtures/views/' + f, import.meta.url), 'utf8')]));
/** Write the fixture workspace file as `dir/name` and its view files to `dir/views`. Returns the path of the workspace file. */
export function writeWorkspace(dir: string, name = 'workspace.trig'): string {
    writeFileSync(join(dir, name), WORKSPACE);
    mkdirSync(join(dir, 'views'), { recursive: true });
    for (const [f, text] of Object.entries(VIEW_FILES)) writeFileSync(join(dir, 'views', f), text);
    return join(dir, name);
}
export const DATA = readFileSync(new URL('./fixtures/data.ttl', import.meta.url), 'utf8');

export const DPROD = 'https://ekgf.github.io/dprod/';
export const DCAT = 'http://www.w3.org/ns/dcat#';
export const DCT = 'http://purl.org/dc/terms/';
export const PROV = 'http://www.w3.org/ns/prov#';
export const DPM = 'osg://vocab/data-product-draft#';

export const meta = (): Promise<Metamodel> => parseShapes(SHAPES, 'shapes.ttl');
/** A TriG as the store reads it: blank nodes replaced by IRIs (skolem.ts). A graph `urn:file:<path>` is a shapes file. */
export async function load(text = MODEL): Promise<ModelGraph> {
    const quads = skolemize((await parseTrig(text)).quads).quads;
    const g = new ModelGraph(new OxigraphStore(quads));
    g.setShapesGraphs(quads.map(q => q.graph).filter((t): t is NamedNode => t.termType === 'NamedNode' && t.value.startsWith(FILE_GRAPH_PREFIX)));
    return g;
}
export const emptyGraph = (): ModelGraph => new ModelGraph(new OxigraphStore());
export const example = () => load();
export const doc = (g: ModelGraph): Doc => project(g).doc;
/** The read model of the whole dataset of a store, with the files of the instances and the paths of file references (test oracle). */
export const docOf = (store: ModelStore): Doc => (store as unknown as { decorate(d: Doc): Doc }).decorate(project((store as unknown as { graph: ModelGraph }).graph).doc);

/** Run a command as one transaction, as the store does; throw on an error result. Returns the result value. */
export function run(g: ModelGraph, m: Classes, c: EditCommand): unknown {
    const { result: r } = g.transact(g => executeCommand(g, m, c));
    if (!r.ok) throw new Error(r.error);
    return r.value;
}

export function byLabel(g: ModelGraph, label: string): string {
    const d = doc(g);
    const hit = [...Object.values(d.instances), ...Object.values(d.views)].find(e => e.label === label);
    if (!hit) throw new Error(`no element "${label}"`);
    return hit.id;
}

/** Value of an ok result. */
export function value<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
    if (!r.ok) throw new Error(r.error);
    return r.value;
}

/** Quads of a Turtle text. */
export async function parseQuads(ttl: string) {
    return [...await rdf.io.dataset.fromText('text/turtle', ttl)];
}
