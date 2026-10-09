// Find Element (search.ts): the things of the store, their kinds, labels and views, on the fixtures.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NS, SearchHit, iriId, viewsShowing } from '@catenary/model';
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
<urn:x:declared> a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Property> ; rdfs:label "Declared property" .
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

const byIri = (hits: SearchHit[]) => new Map(hits.map(h => [h.iri, h]));

describe('search: the things', () => {
    it('are the typed things, the things with a label and no type and the shapes; with their kind', () => {
        const h = byIri(store.search());
        expect(h.get('urn:x:two')).toMatchObject({ id: iriId('urn:x:two'), kind: 'instance', label: 'Two types', types: ['http://www.w3.org/ns/prov#Agent', 'urn:x:Robot'] });
        expect(h.get('urn:x:untyped')).toMatchObject({ kind: 'instance', label: 'Untyped', types: [] });
        expect(h.get('urn:k:S')).toMatchObject({ kind: 'valueSet', label: 'Scheme' });
        expect(h.get('urn:k:a')).toMatchObject({ kind: 'instance', label: 'A' });
        expect(h.get('osg://shapes/data-product-draft#Task')).toMatchObject({ kind: 'shape', label: 'Task' });
        // Predicates are not things: they have no card. Used, or declared with rdf:Property.
        expect(h.has('https://ekgf.github.io/dprod/outputDataset')).toBe(false);
        expect(h.has('urn:x:declared')).toBe(false);
        expect([...h.values()].filter(x => x.kind === 'view').length).toBe(Object.keys(docOf(store).views).length);
        // Not things: RDF structure, the view and SHACL vocabularies, the internals of the views, the report.
        for (const p of ['type', 'first', 'rest', 'reifies']) expect(h.has(NS.rdf + p)).toBe(false);
        expect([...h.keys()].some(k => k.startsWith(NS.sh) || k.startsWith(NS.view))).toBe(false);
        const types = new Set([...h.values()].flatMap(x => x.types));
        for (const t of ['Placement', 'Frame', 'Note', 'FileRef', 'EntityGroup']) expect(types.has(NS.view + t)).toBe(false);
        expect([...types].some(t => t.startsWith(NS.sh + 'Validation'))).toBe(false);
    });

    it('property shapes: the id and the node shape of the shapes index, the label from sh:name or the path', () => {
        const props = store.search().filter(h => h.kind === 'property');
        expect(props.length).toBe(Object.keys(docOf(store).shapes.properties).length);
        for (const p of props) {
            const shape = docOf(store).shapes.properties[p.id];
            expect(shape, p.iri).toBeDefined();
            expect(p.owner).toBe(shape.owner);
            if (shape.name) expect(p.label).toBe(shape.name);
        }
    });

    it('labels: rdfs:label, skos:prefLabel, else the decoded name from the IRI; sorted by label', () => {
        const r = store.search().filter(h => h.types.includes('urn:x:Robot'));
        expect(r.map(h => h.label)).toEqual(['Naïve name', 'Two types']);
    });

    it('views: the views that place the thing, or the node shape of a property shape (viewsShowing of the read model)', () => {
        const doc = docOf(store);
        for (const h of store.search()) expect(h.views, h.iri).toEqual(viewsShowing(doc, h.owner ?? h.id).map(v => v.id));
        expect(store.search().some(h => h.views.length)).toBe(true);
    });
});
