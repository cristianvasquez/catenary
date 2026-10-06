// A SKOS scheme or concept of a shapes file is an instance like one of the data file; its edits stay in its shapes file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { executeCommand } from '../src/commands';
import { ModelGraph, fileGraphIri } from '../src/graph';
import { OxigraphStore } from 'rdf-files';
import { project } from './project-full';
import { formData } from '../src/queries';
import { emptyMetamodel } from '../src/shapes';
import { skolemize } from '../src/skolem';
import { rdf } from '../src/terms';
import { DCAT, parseQuads, run } from './helpers';

const TTL = readFileSync(new URL('./fixtures/dcat-shapes.ttl', import.meta.url), 'utf8');
const FILE = '/tmp/dcat-shapes.ttl';
const GRAPH = rdf.namedNode(fileGraphIri(FILE));
const VOC = 'http://example.org/vocab#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const productAnalytics = rdf.namedNode(VOC + 'product-analytics');

async function load(): Promise<ModelGraph> {
    const g = new ModelGraph(new OxigraphStore());
    g.setShapesGraphs([...g.shapesGraphs(), GRAPH]);
    for (const q of skolemize(await parseQuads(TTL)).quads) g.store.add(rdf.quad(q.subject, q.predicate, q.object, GRAPH));
    for (const q of await parseQuads(`<urn:d1> a <${DCAT}Dataset> ; <${DCAT}theme> <${VOC}product-analytics> .`)) g.store.add(rdf.quad(q.subject, q.predicate, q.object, g.model));
    return g;
}
const exec = (g: ModelGraph, c: Parameters<typeof executeCommand>[2]) => run(g, emptyMetamodel(), c);
const byUri = (g: ModelGraph, uri: string) => Object.values(project(g).doc.instances).find(i => i.uri === uri);
/** Objects of (s, p) in a graph, as values. */
const values = (g: ModelGraph, s: string, p: string, graph = GRAPH) => g.match(rdf.namedNode(s), rdf.namedNode(p), null, graph).map(q => q.object.value);

describe('SKOS subjects of a shapes file', () => {
    it('are instances with their file; a data value that is one of them is a relation', async () => {
        const g = await load();
        expect(byUri(g, VOC + 'product-analytics')).toMatchObject({ label: 'Product analytics', types: [SKOS + 'Concept'], file: FILE });
        expect(byUri(g, VOC + 'product-domain')).toMatchObject({ label: 'Product domain', file: FILE });
        expect(byUri(g, 'urn:d1')?.file).toBeUndefined();
        const d = project(g).doc;
        const theme = Object.values(d.relations).filter(r => r.predicate === DCAT + 'theme');
        expect(theme.map(r => [d.instances[r.subject].uri, d.instances[r.object].uri])).toEqual([['urn:d1', VOC + 'product-analytics']]);
        const inScheme = Object.values(d.relations).filter(r => r.predicate === SKOS + 'inScheme');
        expect(inScheme.map(r => d.instances[r.object].uri)).toEqual([VOC + 'product-domain']);
    });

    it('rename, form statements and delete change the shapes graph, not the data graph; undo restores', async () => {
        const g = await load();
        const id = byUri(g, VOC + 'product-analytics')!.id;
        exec(g, { kind: 'rename', id, label: 'Money' });
        expect(values(g, VOC + 'product-analytics', SKOS + 'prefLabel')).toEqual(['Money']);
        // Only skos:prefLabel in the file: no rdfs:label is added.
        expect(values(g, VOC + 'product-analytics', 'http://www.w3.org/2000/01/rdf-schema#label')).toEqual([]);
        expect(g.match(productAnalytics, null, null, g.model)).toEqual([]);

        exec(g, { kind: 'setStatements', id, values: { [SKOS + 'definition']: [{ termType: 'Literal', value: 'Funds' }] } });
        expect(values(g, VOC + 'product-analytics', SKOS + 'definition')).toEqual(['Funds']);
        expect(formData(g, productAnalytics)).toContain('Funds');

        const before = g.quads().length;
        const { result, patch } = g.transact(x => executeCommand(x, emptyMetamodel(), { kind: 'delete', ids: [id] }));
        expect(result.ok).toBe(true);
        expect(g.match(productAnalytics)).toEqual([]);
        expect(g.match(null, null, productAnalytics)).toEqual([]);
        expect(byUri(g, VOC + 'product-analytics')).toBeUndefined();
        g.undo(patch);
        expect(g.quads().length).toBe(before);
        expect(byUri(g, VOC + 'product-analytics')?.label).toBe('Money');
    });
});
