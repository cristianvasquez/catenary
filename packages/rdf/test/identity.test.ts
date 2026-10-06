import { describe, expect, it } from 'vitest';
import { boxes, inView } from '@catenary/model';
import { mint, ModelGraph } from '../src/graph';
import * as ids from '../src/ids';
import { renameElement } from '../src/elements';
import * as ops from '../src/ops';
import { writeTrig } from '../src/trig';
import { DCAT, DPROD, byLabel, doc, emptyGraph, example, load, meta, value } from './helpers';

const iri = (g: ModelGraph, id: string) => { const d = doc(g); return (d.instances[id] ?? d.views[id]).uri; };

describe('IRI minting', () => {
    it('mints urn:name: IRIs from labels with canonical-md', () => {
        expect(mint('Product usage data')).toBe('urn:name:Product%20usage%20data');
        expect(mint('Agent / chatbot')).toBe('urn:name:Agent%20%2F%20chatbot');
    });

    it('mints at creation; set uri replaces it; empty mints again from the label', () => {
        const g = emptyGraph();
        let id = value(ops.createInstance(g, DCAT + 'Dataset', 'Product events'));
        expect(iri(g, id)).toBe('urn:name:Product%20events');
        id = value(ops.setUri(g, id, 'https://example.org/product-events'));
        expect(iri(g, id)).toBe('https://example.org/product-events');
        expect(ops.setUri(g, id, 'not an iri').ok).toBe(false);
        renameElement(g, id, 'Ballots');
        id = value(ops.setUri(g, id, ''));
        expect(iri(g, id)).toBe('urn:name:Ballots');
    });

    it('mints label-2, label-3 on a clash, across instances, views and the model graph', () => {
        const g = emptyGraph();
        const a = value(ops.createInstance(g, DCAT + 'Dataset', 'A'));
        const b = value(ops.createInstance(g, DCAT + 'Dataset', 'A'));
        const v = value(ops.createView(g, 'A'));
        const m = value(ops.createInstance(g, DCAT + 'Dataset', 'model'));
        expect([iri(g, a), iri(g, b), iri(g, v), iri(g, m)]).toEqual(['urn:name:A', 'urn:name:A-2', 'urn:name:A-3', 'urn:name:model-2']);
    });

    it('refuses to set an IRI used by another element', () => {
        const g = emptyGraph();
        const a = value(ops.createInstance(g, DCAT + 'Dataset', 'A'));
        const b = value(ops.createInstance(g, DCAT + 'Dataset', 'B'));
        expect(ops.setUri(g, b, 'urn:name:A').ok).toBe(false);
        expect(ops.setUri(g, a, 'urn:name:model').ok).toBe(false);
        expect(ops.setUri(g, a, 'urn:name:A').ok).toBe(true);
    });

    it('keeps the IRI of the file on import', async () => {
        const g = await load(`<urn:name:model> { <https://ex.org/a> a <${DCAT}Dataset> ; <http://www.w3.org/2000/01/rdf-schema#label> "A" . }`);
        expect(doc(g).instances[byLabel(g, 'A')].uri).toBe('https://ex.org/a');
    });

    it('set uri gives a new element id; undo gives the old IRI and id back', async () => {
        const g = await example();
        const id = byLabel(g, 'Query service');
        const ctx = byLabel(g, 'Product context');
        const { result, patch } = g.transact(g => ops.setUri(g, id, 'https://ex.org/query'));
        const moved = value(result);
        expect(moved).not.toBe(id);
        expect(doc(g).instances[id]).toBeUndefined();
        expect(doc(g).instances[moved].uri).toBe('https://ex.org/query');
        expect(inView(doc(g).views[ctx], moved)).toBe(true);
        g.undo(patch);
        expect(doc(g).instances[id].uri).toBe('urn:name:Query%20service');
        g.redo(patch);
        expect(doc(g).instances[moved].uri).toBe('https://ex.org/query');
    });

    it('set uri of a view gives a new view id with the same content', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const nodes = boxes(doc(g).views[ctx], 'card').length;
        const moved = value(ops.setUri(g, ctx, 'https://ex.org/view'));
        expect(doc(g).views[moved]).toMatchObject({ uri: 'https://ex.org/view', label: 'Product context' });
        expect(boxes(doc(g).views[moved], 'card')).toHaveLength(nodes);
    });

    it('ids encode the terms: readable, reversible, DOM-safe', async () => {
        const g = await example();
        const id = byLabel(g, 'Query service');
        expect(id).toBe('n-urn_3aname_3aQuery_2520service');
        expect(ids.elementTerm(id)?.value).toBe('urn:name:Query%20service');
        for (const r of Object.keys(doc(g).relations)) {
            const t = ids.relationTriple(r)!;
            expect(ids.relationId(t.s, t.p, t.o)).toBe(r);
            expect(r).toMatch(/^[A-Za-z0-9_-]+$/);
        }
        expect(ids.elementTerm('n-_zz')).toBeUndefined();
        expect(ids.relationTriple('r-a-b')).toBeUndefined();
    });
});

describe('labels', () => {
    it('accepts duplicate labels, refuses empty labels and outer spaces', () => {
        const g = emptyGraph();
        expect(ops.createInstance(g, DCAT + 'Dataset', 'A').ok).toBe(true);
        expect(ops.createInstance(g, DCAT + 'Dataset', 'A').ok).toBe(true);
        expect(ops.createView(g, 'A').ok).toBe(true);
        expect(ops.createInstance(g, DCAT + 'Dataset', '').ok).toBe(false);
        expect(ops.createInstance(g, DCAT + 'Dataset', ' B').ok).toBe(false);
    });
});

describe('rename', () => {
    it('keeps the IRI, relations and view references', async () => {
        const m = await meta();
        const g = await example();
        const id = byLabel(g, 'Product events dataset');
        const second = value(ops.createView(g, 'Second'));
        ops.addToView(g, second, id, { x: 0, y: 0 });
        expect(renameElement(g, id, 'EP mirror').ok).toBe(true);

        const out = await writeTrig(g.quads());
        expect(out).toContain('urn:name:Product%20events%20dataset');
        const again = await load(out);
        const d = doc(again);
        const nid = byLabel(again, 'EP mirror');
        expect(d.instances[nid].uri).toBe('urn:name:Product%20events%20dataset');
        const rels = Object.values(d.relations).filter(r => r.subject === nid || r.object === nid);
        expect(rels.map(r => r.predicate).sort()).toEqual(
            [DPROD + 'inputDataset', DPROD + 'outputDataset', 'osg://vocab/data-product-draft#exposedThrough'].sort());
        expect(Object.values(d.views).filter(v => inView(v, nid)).map(v => v.label).sort())
            .toEqual(['Product context', 'Second']);
        expect(m.classes.length).toBeGreaterThan(0);
    });

    it('with a set uri: export uses it in the model graph and in every view graph', async () => {
        const g = await example();
        const id = value(ops.setUri(g, byLabel(g, 'Query service'), 'https://data.example.org/service/query'));
        const second = value(ops.createView(g, 'Second'));
        ops.addToView(g, second, id, { x: 0, y: 0 });
        const out = await writeTrig(g.quads());
        expect(out).not.toContain('urn:name:Query%20service');
        const back = await load(out);
        const d = doc(back);
        const q = d.instances[byLabel(back, 'Query service')];
        expect(q.uri).toBe('https://data.example.org/service/query');
        for (const v of Object.values(d.views)) expect(inView(v, q.id)).toBe(true);
        expect(Object.values(d.relations).filter(r => r.object === q.id)).toHaveLength(3);
        expect(d.views[byLabel(back, 'Second')].uri).toBe('urn:name:Second');
    });
});
