// The Search panel and Find Element (search.ts): the faceted search of the store, its facet counts and labels, on the fixtures.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NS, SearchFacets, SearchHit, iriId, viewsShowing } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';

const MORE = `@prefix skos: <${NS.skos}> . @prefix rdfs: <${NS.rdfs}> .
<urn:k:S> a skos:ConceptScheme ; skos:prefLabel "Scheme" .
<urn:k:a> a skos:Concept ; skos:prefLabel "A" ; skos:topConceptOf <urn:k:S> .
<urn:x:two> a <http://www.w3.org/ns/prov#Agent>, <urn:x:Robot> ; rdfs:label "Two types" ; rdfs:comment "multi   line\\n value" .
<urn:x:untyped> rdfs:label "Untyped" ; <urn:x:knows> <urn:x:two> .
<urn:x:set> a <http://www.w3.org/ns/dcat#Dataset> ; rdfs:label "Set of a robot" .
<urn:x:two> <https://ekgf.github.io/dprod/outputDataset> <urn:x:set> .
<urn:x:Na%C3%AFve%20name> a <urn:x:Robot> .
`;

let dir: string, store: ModelStore;
async function open(): Promise<void> {
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
    await store.validate();
}
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-search-'));
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    writeFileSync(join(dir, 'more.ttl'), MORE);
    await open();
});
afterEach(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const ALL = 10_000;
const search = (f: SearchFacets, limit = ALL) => store.search(f, limit);
const byIri = (hits: SearchHit[]) => new Map(hits.map(h => [h.iri, h]));
const iris = (f: SearchFacets) => search(f).hits.map(h => h.iri).sort();
const count = (f: SearchFacets, type: string) => search(f).types.find(t => t.value === type)?.count;

describe('search: the things', () => {
    it('are the typed things, the things with a label and no type, the shapes and the predicates; with their kind', () => {
        const h = byIri(search({}).hits);
        expect(h.get('urn:x:two')).toMatchObject({ id: iriId('urn:x:two'), kind: 'instance', label: 'Two types', types: ['http://www.w3.org/ns/prov#Agent', 'urn:x:Robot'] });
        expect(h.get('urn:x:untyped')).toMatchObject({ kind: 'instance', label: 'Untyped', types: [] });
        expect(h.get('urn:k:S')).toMatchObject({ kind: 'valueSet', label: 'Scheme' });
        expect(h.get('urn:k:a')).toMatchObject({ kind: 'instance', label: 'A' });
        expect(h.get('osg://shapes/data-product-draft#Task')).toMatchObject({ kind: 'shape', label: 'Task' });
        expect(h.get('https://ekgf.github.io/dprod/outputDataset')).toMatchObject({ kind: 'predicate', label: 'outputDataset' });
        expect([...h.values()].filter(x => x.kind === 'view').length).toBe(Object.keys(docOf(store).views).length);
        // Not things: RDF structure, the view and SHACL vocabularies, the internals of the views, the report.
        for (const p of ['type', 'first', 'rest', 'reifies']) expect(h.has(NS.rdf + p)).toBe(false);
        expect([...h.keys()].some(k => k.startsWith(NS.sh) || k.startsWith(NS.view))).toBe(false);
        const types = new Set([...h.values()].flatMap(x => x.types));
        for (const t of ['Placement', 'Frame', 'Note', 'FileRef', 'EntityGroup']) expect(types.has(NS.view + t)).toBe(false);
        expect([...types].some(t => t.startsWith(NS.sh + 'Validation'))).toBe(false);
    });

    it('property shapes: the id and the node shape of the shapes index, the label from sh:name or the path', () => {
        const props = search({}).hits.filter(h => h.kind === 'property');
        expect(props.length).toBe(Object.keys(docOf(store).shapes.properties).length);
        for (const p of props) {
            const shape = docOf(store).shapes.properties[p.id];
            expect(shape, p.iri).toBeDefined();
            expect(p.owner).toBe(shape.owner);
            if (shape.name) expect(p.label).toBe(shape.name);
        }
    });

    it('labels: rdfs:label, skos:prefLabel, else the decoded name from the IRI; sorted by label', () => {
        const r = search({ type: 'urn:x:Robot' }).hits;
        expect(r.map(h => h.label)).toEqual(['Naïve name', 'Two types']);
    });

    it('views: the views that place the thing, or the node shape of a property shape (viewsShowing of the read model)', () => {
        for (const h of search({}).hits) if (h.kind !== 'predicate') expect(h.views, h.iri).toEqual(viewsShowing(docOf(store), h.owner ?? h.id).map(v => v.id));
        expect(search({}).hits.some(h => h.views.length)).toBe(true);
    });

    it(`gives the first \`limit\` by label, and \`more\``, () => {
        const all = search({}).hits;
        const r = search({}, 5);
        expect(r.more).toBe(true);
        expect(r.hits.length).toBe(5);
        expect(search({}).more).toBe(false);
        // The cut is in IRI order, then the hits are sorted by label: each hit of the page is a hit of the whole answer.
        for (const h of r.hits) expect(all.map(x => x.id)).toContain(h.id);
    });
});

describe('search: the facets', () => {
    it('text: each word in the local name of the IRI or in a literal, case-insensitive', () => {
        expect(iris({ text: 'TWO multi' })).toEqual(['urn:x:two']);
        expect(iris({ text: 'outputdataset' })).toEqual(['https://ekgf.github.io/dprod/outputDataset']);
        // The namespace of an IRI is not searched: "data-product-draft" is in the IRIs of all node shapes.
        expect(search({ text: 'draft' }).hits.filter(h => h.kind === 'shape')).toEqual([]);
        // A word only in a type IRI: the type facet gives it, not the text.
        expect(iris({ text: 'two robot' })).toEqual([]);
    });

    it('type: the things of one type; rdfs:Resource gives the things without a type', () => {
        expect(iris({ type: 'http://www.w3.org/ns/prov#Agent' })).toContain('urn:x:two');
        expect(iris({ type: NS.rdfs + 'Resource' })).toEqual(['urn:x:untyped']);
    });

    it('linked to: the other ends of the statements; direction and predicate narrow it', () => {
        const two = iriId('urn:x:two');
        const r = search({ linkedTo: two });
        expect(r.hits.map(h => h.iri).sort()).toEqual(['urn:x:set', 'urn:x:untyped']);
        expect(r.linked).toMatchObject({ id: two, label: 'Two types', iri: 'urn:x:two' });
        expect(iris({ linkedTo: two, direction: 'in' })).toEqual(['urn:x:untyped']);
        expect(iris({ linkedTo: two, direction: 'out', predicate: 'https://ekgf.github.io/dprod/outputDataset' })).toEqual(['urn:x:set']);
        expect(iris({ linkedTo: two, direction: 'out', predicate: 'urn:x:knows' })).toEqual([]);
    });

    it('linked to an element with no statement: no `linked` (the panel removes the facet)', () => {
        expect(search({ linkedTo: iriId('urn:x:gone') }).linked).toBeUndefined();
    });
});

describe('search: the facet counts apply the other facets, not their own', () => {
    it('type counts: the things of each type with the text and "linked to"', () => {
        expect(count({}, 'http://www.w3.org/ns/prov#Agent')).toBe(iris({ type: 'http://www.w3.org/ns/prov#Agent' }).length);
        expect(count({}, NS.sh + 'PropertyShape')).toBe(Object.keys(docOf(store).shapes.properties).length);
        // The type facet does not change its own counts.
        expect(search({ type: 'urn:x:Robot' }).types).toEqual(search({}).types);
        expect(count({ text: 'two' }, 'urn:x:Robot')).toBe(1);
        expect(search({ linkedTo: iriId('urn:x:two') }).types.map(t => [t.value, t.count])).toEqual([
            [NS.rdfs + 'Resource', 1], ['http://www.w3.org/ns/dcat#Dataset', 1]]);
    });

    it('link counts: the things of each relation type of "linked to", with the text and the type', () => {
        const two = iriId('urn:x:two');
        const links = (f: SearchFacets) => search({ linkedTo: two, ...f }).linked!.links.map(l => [l.value.direction, l.value.predicate, l.count]);
        const both = [['in', 'urn:x:knows', 1], ['out', 'https://ekgf.github.io/dprod/outputDataset', 1]];
        expect(links({})).toEqual(both);
        // The predicate and direction facets do not change their own counts.
        expect(links({ direction: 'in', predicate: 'urn:x:knows' })).toEqual(both);
        expect(links({ type: 'http://www.w3.org/ns/dcat#Dataset' })).toEqual([['out', 'https://ekgf.github.io/dprod/outputDataset', 1]]);
    });
});
