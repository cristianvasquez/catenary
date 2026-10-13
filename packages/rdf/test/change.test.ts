import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Doc, NS, SnapshotChange, boxes, emptyDoc } from '@catenary/model';
import type { NamedNode } from '@rdfjs/types';
import { OxigraphStore } from 'rdf-files';
import { classify, keepsReads, mergeRecords, refreshes, tierOf, validates } from '../src/change';
import { ModelGraph, REPORT_GRAPH, dataGraphIri } from '../src/graph';
import { elementId } from '../src/ids';
import { ModelStore } from '../src/model-store';
import { rdf } from '../src/terms';
import { docOf } from './helpers';
import { newModelGraph } from '../src/model-graph';

// spec/manifest.hs §11.3 Change propagation and §9 validates: the rules of change.ts, one function each.

const n = (s: string) => rdf.namedNode('urn:test:' + s);
const view = n('view'), data = rdf.namedNode(dataGraphIri('/data.ttl')), shapes = n('shapes');
const change = (c: Partial<SnapshotChange> & { reason: SnapshotChange['reason'] }): SnapshotChange => ({ views: [], elements: [], shapes: false, layout: false, ...c });

/** A graph with a data graph, a shapes graph and one view. */
function graph(): ModelGraph {
    const g = newModelGraph(new OxigraphStore());
    g.setDataGraphs([data]);
    g.setShapesGraphs([shapes]);
    g.transact(x => { x.add(view, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'View'), view); return { ok: true }; });
    return g;
}

describe('tierOf', () => {
    it('a load, a disk read, a files or shapes change, or a shapes flag: Rebuild; a layout-only edit, undo or redo: ViewPatch; else DataPatch', () => {
        for (const reason of ['load', 'files', 'disk', 'shapes'] as const) expect(tierOf(change({ reason, layout: true }))).toBe('rebuild');
        for (const reason of ['edit', 'undo', 'redo'] as const) {
            expect(tierOf(change({ reason, shapes: true, layout: true }))).toBe('rebuild');
            expect(tierOf(change({ reason, layout: true }))).toBe('view');
            expect(tierOf(change({ reason }))).toBe('data');
        }
        expect(tierOf(change({ reason: 'validation' }))).toBe('data');
        expect(tierOf(change({ reason: 'save', layout: true }))).toBe('data');
    });
});

describe('classify', () => {
    it('a patch of placement geometry and style is a ViewPatch of its view that invalidates the persisted text only', () => {
        const g = graph();
        const { patch } = g.transact(x => { x.add(n('p1'), rdf.namedNode(NS.view + 'x'), rdf.literal('10'), view); x.add(n('p1'), rdf.namedNode(NS.view + 'color'), rdf.literal('#fff'), view); return { ok: true }; });
        const c = classify(g, patch, 'edit');
        expect(c).toMatchObject({ tier: 'view', views: [elementId(view)], elements: [], shapes: false, layout: true, validates: false });
        expect(c.invalidates).toEqual({ shapes: false, query: false, data: false, persisted: true });
    });
    it('a patch of data statements is a DataPatch with the subject and the IRI object as elements, and validates', () => {
        const g = graph();
        const { patch } = g.transact(x => { x.add(n('a'), n('p'), n('b'), data); x.add(n('a'), rdf.namedNode(NS.rdfs + 'label'), rdf.literal('A'), data); return { ok: true }; });
        const c = classify(g, patch, 'undo');
        expect(c).toMatchObject({ tier: 'data', views: [], elements: [elementId(n('a')), elementId(n('b'))], shapes: false, layout: false, validates: true });
        expect(c.invalidates).toEqual({ shapes: false, query: true, data: true, persisted: true });
    });
    it('a patch with a placement and data (a created instance) is a DataPatch that names the view and the element', () => {
        const g = graph();
        const { patch } = g.transact(x => { x.add(n('a'), rdf.namedNode(NS.rdfs + 'label'), rdf.literal('A'), data); x.add(n('p1'), rdf.namedNode(NS.view + 'element'), n('a'), view); return { ok: true }; });
        expect(classify(g, patch, 'edit')).toMatchObject({ tier: 'data', views: [elementId(view)], elements: [elementId(n('a'))], layout: false, validates: true });
    });
    it('a shapes statement, or a SKOS or RDFS statement of the data, is a Rebuild that invalidates the shapes index', () => {
        const g = graph();
        const shape = g.transact(x => { x.add(n('s'), rdf.namedNode(NS.sh + 'targetClass'), n('C'), shapes); return { ok: true }; }).patch;
        expect(classify(g, shape, 'edit')).toMatchObject({ tier: 'rebuild', shapes: true, elements: [], validates: true, invalidates: { shapes: true, query: true, data: true, persisted: true } });
        const skos = g.transact(x => { x.add(n('c'), rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.skos + 'Concept'), data); return { ok: true }; }).patch;
        expect(classify(g, skos, 'edit')).toMatchObject({ tier: 'rebuild', shapes: true, elements: [elementId(n('c')), elementId(rdf.namedNode(NS.skos + 'Concept'))], invalidates: { shapes: true } });
        const rdfs = g.transact(x => { x.add(n('p'), rdf.namedNode(NS.rdfs + 'domain'), n('C'), data); return { ok: true }; }).patch;
        expect(classify(g, rdfs, 'redo')).toMatchObject({ tier: 'rebuild', shapes: true });
    });
    it('the report graph is in no scope and invalidates nothing', () => {
        const g = graph();
        const { patch } = g.transact(x => { x.add(n('r'), n('p'), rdf.literal('x'), rdf.namedNode(REPORT_GRAPH)); return { ok: true }; });
        expect(classify(g, patch, 'validation')).toMatchObject({ tier: 'data', views: [], elements: [], shapes: false, layout: false, validates: false, invalidates: { shapes: false, query: false, data: false, persisted: false } });
    });
    it('the tier follows the reason: the same patch is a Rebuild after a load or a disk read', () => {
        const g = graph();
        const { patch } = g.transact(x => { x.add(n('p1'), rdf.namedNode(NS.view + 'x'), rdf.literal('10'), view); return { ok: true }; });
        expect(classify(g, patch, 'load').tier).toBe('rebuild');
        expect(classify(g, patch, 'disk').tier).toBe('rebuild');
        expect(classify(g, patch, 'edit').tier).toBe('view');
    });
});

describe('validates', () => {
    it('runs after data or shapes statements, not after a layout change', () => {
        expect(validates({ layout: true, elements: [], shapes: false, views: ['v'] })).toBe(false);
        expect(validates({ layout: false, elements: ['a'], shapes: false, views: [] })).toBe(true);
        expect(validates({ layout: false, elements: [], shapes: true, views: [] })).toBe(true);
        expect(validates({ layout: false, elements: [], shapes: false, views: ['v'] })).toBe(false);
    });
    it('in the mode "views", a placement change of an open view runs it too (§9 validationFocus)', () => {
        expect(validates({ layout: false, elements: [], shapes: false, views: ['v'] }, ['v'])).toBe(true);
        expect(validates({ layout: false, elements: [], shapes: false, views: ['w'] }, ['v'])).toBe(false);
        expect(validates({ layout: true, elements: [], shapes: false, views: ['v'] }, ['v'])).toBe(false);
    });
});

describe('keepsReads', () => {
    it('a save and a ViewPatch keep the reads; a DataPatch and a Rebuild do not', () => {
        expect(keepsReads(change({ reason: 'save' }))).toBe(true);
        expect(keepsReads(change({ reason: 'edit', layout: true }))).toBe(true);
        expect(keepsReads(change({ reason: 'edit' }))).toBe(false);
        expect(keepsReads(change({ reason: 'edit', layout: true, shapes: true }))).toBe(false);
        expect(keepsReads(change({ reason: 'load', layout: true }))).toBe(false);
    });
    it('the data key of the graph stays on a ViewPatch and moves on a DataPatch (the per-quad form of the rule)', () => {
        const g = graph();
        const key = g.keys.data;
        const layout = g.transact(x => { x.add(n('p1'), rdf.namedNode(NS.view + 'x'), rdf.literal('10'), view); return { ok: true }; }).patch;
        expect(keepsReads({ reason: 'edit', ...classify(g, layout, 'edit') })).toBe(true);
        expect(g.keys.data).toBe(key);
        const content = g.transact(x => { x.add(n('a'), n('p'), rdf.literal('x'), data); return { ok: true }; }).patch;
        expect(keepsReads({ reason: 'edit', ...classify(g, content, 'edit') })).toBe(false);
        expect(g.keys.data).not.toBe(key);
    });
});

describe('refreshes', () => {
    const part = (): Doc => {
        const d = emptyDoc();
        d.views.v = { id: 'v', label: 'V', uri: 'urn:v', boxes: [], edges: [], arrows: [] };
        d.views.ref = { id: 'ref', label: 'Ref', uri: 'urn:ref', boxes: [], edges: [], arrows: [] };
        d.instances.a = { id: 'a', label: 'A', uri: 'urn:a', types: [], fields: {} };
        d.shapes.properties.ps = { id: 'ps', owner: 'ns', label: 'p' } as unknown as Doc['shapes']['properties'][string];
        return d;
    };
    it('no scope: every canvas', () => {
        expect(refreshes(part(), 'v', undefined)).toBe(true);
    });
    it('law_viewPatchRefreshesOwnViewOnly: a ViewPatch refreshes the canvases of the changed views only', () => {
        expect(refreshes(part(), 'v', change({ reason: 'edit', layout: true, views: ['v'] }))).toBe(true);
        expect(refreshes(part(), 'v', change({ reason: 'edit', layout: true, views: ['ref'] }))).toBe(false);
        expect(refreshes(part(), 'v', change({ reason: 'edit', layout: true, views: ['other'], elements: ['a'] }))).toBe(false);
    });
    it('a DataPatch or a Rebuild refreshes a canvas on a shapes change, a changed view it holds or a changed element it holds', () => {
        expect(refreshes(part(), 'v', change({ reason: 'edit', shapes: true }))).toBe(true);
        expect(refreshes(part(), 'v', change({ reason: 'edit', views: ['ref'] }))).toBe(true);
        expect(refreshes(part(), 'v', change({ reason: 'edit', views: ['other'] }))).toBe(false);
        expect(refreshes(part(), 'v', change({ reason: 'edit', elements: ['a'] }))).toBe(true);
        expect(refreshes(part(), 'v', change({ reason: 'validation', elements: ['ps'] }))).toBe(true);
        expect(refreshes(part(), 'v', change({ reason: 'edit', elements: ['b'] }))).toBe(false);
        expect(refreshes(part(), 'v', change({ reason: 'load' }))).toBe(false);
    });
});

describe('law_keptDocEqualsRead: the DataPatch merge of a kept part (mergeRecords, ModelStore.mergeChanged)', () => {
    let dir: string, store: ModelStore, viewId: string, a: string, b: string, outside: string;
    const ok = (r: ReturnType<ModelStore['execute']>) => { if (!r.ok) throw new Error(r.error); return r; };
    // Each test edits the store: each gets a new workspace.
    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'catenary-change-'));
        store = new ModelStore();
        store.watching = false;
        expect(await store.create(join(dir, 'workspace.trig'), { instances: 'data.ttl' })).toEqual({ ok: true });
        viewId = ok(store.execute({ kind: 'createView', label: 'View' })).id!;
        a = ok(store.execute({ kind: 'createInstance', classIri: 'urn:Class', label: 'A', view: viewId, at: { x: 0, y: 0 } })).id!;
        b = ok(store.execute({ kind: 'createInstance', classIri: 'urn:Class', label: 'B', view: viewId, at: { x: 600, y: 0 } })).id!;
        outside = ok(store.execute({ kind: 'createInstance', classIri: 'urn:Class', label: 'Outside' })).id!;
        const shape = ok(store.execute({ kind: 'createNodeShape', label: 'Class shape', targetClass: 'urn:Class' })).id!;
        for (const p of ['urn:p', 'urn:q']) ok(store.execute({ kind: 'createPropertyShape', shape, path: { kind: 'iri', iri: p }, range: { kind: 'class', class: 'urn:Class' } }));
    });
    afterEach(async () => { await store.dispose(); rmSync(dir, { recursive: true, force: true }); });
    /** What toSchema reads: boxes, edges, arrows, the label, types and fields of the shown instances, the relations between them. */
    const shown = (doc: Doc) => {
        const v = doc.views[viewId];
        const ids = new Set([...boxes(v, 'card').map(c => c.element), ...boxes(v, 'collection').flatMap(c => c.members)]);
        return {
            boxes: v.boxes, edges: v.edges, arrows: v.arrows,
            instances: Object.fromEntries([...ids].filter(id => doc.instances[id]).map(id => { const { label, types, fields } = doc.instances[id]; return [id, { label, types, fields }]; })),
            relations: Object.values(doc.relations).filter(r => ids.has(r.subject) && ids.has(r.object)).sort((x, y) => x.id.localeCompare(y.id))
        };
    };

    it('a rename, a statement edit (a field, a relation among shown cards, one to a card outside the view), their undo and redo', () => {
        const uri = (id: string) => docOf(store).instances[id].uri;
        const part = store.viewDoc(viewId);
        const changes: Array<[string, () => string[]]> = [
            ['rename', () => { ok(store.execute({ kind: 'rename', id: a, label: 'Renamed' })); return [a]; }],
            ['field', () => { ok(store.execute({ kind: 'setStatements', id: a, values: { 'urn:note': [{ termType: 'Literal', value: 'x' }] } })); return [a]; }],
            ['relation inside', () => { ok(store.execute({ kind: 'setStatements', id: a, values: { 'urn:p': [{ termType: 'NamedNode', value: uri(b) }] } })); return [a, b]; }],
            ['relation outside', () => { ok(store.execute({ kind: 'setStatements', id: b, values: { 'urn:q': [{ termType: 'NamedNode', value: uri(outside) }] } })); return [b, outside]; }],
            ['undo', () => { store.undo(); return [b, outside]; }],
            ['undo', () => { store.undo(); return [a, b]; }],
            ['redo', () => { store.redo(); return [a, b]; }],
            ['undo', () => { store.undo(); return [a, b]; }],
            ['undo', () => { store.undo(); return [a]; }],
            ['undo', () => { store.undo(); return [a]; }]
        ];
        for (const [step, run] of changes) {
            const elements = run();
            // The arrival of the relation as a placed edge is a view graph change: the canvas reads the view again (view-session.ts).
            const placements = store.snapshot().change?.views?.length;
            if (placements) { Object.assign(part, store.viewDoc(viewId)); continue; }
            expect(store.mergeChanged(part, viewId, elements), step).toBe(true);
            expect(shown(part), step).toEqual(shown(store.viewDoc(viewId)));
        }
    });

    it('a changed element that the part does not hold and the view does not place merges nothing', () => {
        const part = store.viewDoc(viewId);
        expect(store.mergeChanged(part, viewId, [outside, 'n-urn_3atest_3anone'])).toBe(true);
        expect(shown(part)).toEqual(shown(store.viewDoc(viewId)));
    });

    it('law_keptDocEqualsRead: a changed mark (a note in a data file) that the view places needs a read: its box content is not merged', () => {
        const note = ok(store.execute({ kind: 'createNote', view: viewId, text: 'Old', at: { x: -600, y: 0 } })).id!;
        const g = (store as unknown as { graph: ModelGraph }).graph;
        const dataGraph = g.dataGraphs()[0], viewGraph = rdf.namedNode(docOf(store).views[viewId].uri);
        const mark = g.match(null, rdf.namedNode(NS.view + 'element'), null, viewGraph).map(q => q.object as NamedNode).find(o => g.match(o, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'Note')).length)!;
        g.transact(x => { for (const q of x.match(mark, null, null, viewGraph)) { x.remove(q); x.add(q.subject, q.predicate, q.object, dataGraph); } return { ok: true }; });
        const part = store.viewDoc(viewId);
        ok(store.execute({ kind: 'setViewElements', view: viewId, ids: [note], patch: { text: 'New' } }));
        const change = store.snapshot().change!;
        expect(change).toMatchObject({ reason: 'edit', tier: 'data', views: [], elements: [elementId(mark)] });
        expect(store.mergeChanged(part, viewId, change.elements!)).toBe(false);
        expect(shown(store.viewDoc(viewId)).boxes.find(b => b.id === note)).toMatchObject({ text: 'New' });
        store.undo();
        ok(store.execute({ kind: 'removeFromView', view: viewId, ids: [note] }));
    });

    it('mergeRecords keeps the relations of unchanged instances and orders the edges by their statement', () => {
        const part = emptyDoc();
        const inst = (id: string) => ({ id, label: id, uri: 'urn:' + id, types: [], fields: {} });
        for (const id of ['a', 'b', 'c']) part.instances[id] = inst(id);
        part.relations.bc = { id: 'bc', subject: 'b', predicate: 'urn:p', object: 'c' };
        part.relations.ab = { id: 'ab', subject: 'a', predicate: 'urn:p', object: 'b' };
        part.views.v = { id: 'v', label: 'V', uri: 'urn:v', boxes: ['a', 'b', 'c'].map(id => ({ kind: 'card' as const, id: 'p' + id, element: id, x: 0, y: 0, width: 1, height: 1 })), edges: [{ relation: 'ab', hidden: true }, { id: 'e', relation: 'bc' }], arrows: [] };
        const fresh = emptyDoc();
        fresh.instances.a = { ...inst('a'), label: 'A!' };
        fresh.instances.d = inst('d');
        fresh.relations.ac = { id: 'ac', subject: 'a', predicate: 'urn:p', object: 'c' };
        fresh.relations.ad = { id: 'ad', subject: 'a', predicate: 'urn:p', object: 'd' };
        expect(mergeRecords(part, 'v', fresh, ['a'])).toEqual(['ac']);
        expect(part.instances.a.label).toBe('A!');
        expect(part.instances.d).toBeUndefined();
        expect(Object.keys(part.relations).sort()).toEqual(['ac', 'bc']);
        expect(part.views.v.edges).toEqual([{ relation: 'ac', hidden: true }, { id: 'e', relation: 'bc' }]);
    });
});
