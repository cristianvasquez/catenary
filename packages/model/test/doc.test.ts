import { describe, expect, it } from 'vitest';
import { Doc, View, boxShowing, elementLabel, emptyShapes, groupOf, hiddenNeighbors, kindName, kindOf, relationLabel, viewsShowing } from '../src';
import { unplacedInstances } from './doc-reference';

const box = { x: 0, y: 0, width: 100, height: 50 };
const view = (id: string, instances: string[], extra: Partial<View> = {}): View =>
    ({ id, label: id, uri: id, edges: [], arrows: [], ...extra, boxes: [...instances.map(i => ({ kind: 'card' as const, id: i, element: i, ...box })), ...(extra.boxes ?? [])] });

function doc(): Doc {
    const instances = Object.fromEntries(['a', 'b'].map(id => [id, { id, label: id.toUpperCase(), types: [], uri: id, fields: {} }]));
    return {
        instances,
        relations: { ab: { id: 'ab', subject: 'a', predicate: 'urn:p', object: 'b' } },
        views: {
            V1: view('V1', ['a', 'b'], { boxes: [{ kind: 'group', id: 'g', label: 'G', ...box }, { kind: 'note', id: 'n', text: 'first\nsecond', ...box }] }),
            V2: view('V2', ['a', 'b'], { edges: [{ relation: 'ab', hidden: true }] }),
            V3: view('V3', ['a'])
        },
        shapes: emptyShapes()
    };
}

describe('queries on the read model', () => {
    it('views that show an element: cards for instances, both ends and a visible edge for relations', () => {
        const d = doc();
        expect(viewsShowing(d, 'a').map(v => v.id)).toEqual(['V1', 'V2', 'V3']);
        expect(viewsShowing(d, 'ab').map(v => v.id)).toEqual(['V1']);
        expect(viewsShowing(d, 'ab', true).map(v => v.id)).toEqual(['V1', 'V2']);
    });

    it('a concept shown as a row of a scheme or collection card counts as shown in that view; the box is that card; it has no placement', () => {
        const d = doc();
        d.instances.c = { id: 'c', label: 'Append', types: ['http://www.w3.org/2004/02/skos/core#Concept'], uri: 'urn:c', fields: {} };
        d.shapes.valueSets.s = { id: 's', uri: 'urn:s', kind: 'scheme', label: 'Task action', file: 'data.ttl', members: [{ uri: 'urn:c', label: 'Append' }] };
        d.views.V3.boxes.push({ kind: 'card', id: 's', element: 's', ...box });
        expect(viewsShowing(d, 'c').map(v => v.id)).toEqual(['V3']);
        expect(unplacedInstances(d)).toContain('c');
        expect(boxShowing(d, d.views.V3, 'c')).toBe('s');
        expect(boxShowing(d, d.views.V3, 'a')).toBe('a');
        expect(boxShowing(d, d.views.V1, 'c')).toBeUndefined();
    });

    it('hidden neighbors: related instances that the view does not show, per direction, one entry per instance', () => {
        const d = doc();
        d.instances.c = { id: 'c', label: 'C', types: [], uri: 'urn:c', fields: {} };
        d.instances.s = { id: 's', label: 'S', types: [], uri: 's', fields: {} };
        d.relations.ca = { id: 'ca', subject: 'c', predicate: 'urn:q', object: 'a' };
        d.relations.ca2 = { id: 'ca2', subject: 'c', predicate: 'urn:r', object: 'a' };
        d.relations.aa = { id: 'aa', subject: 'a', predicate: 'urn:p', object: 'a' };
        const out = (v: string) => hiddenNeighbors(d, d.views[v], 'a', 'out').map(n => [n.instance.id, n.relations.map(r => r.id)]);
        const inc = (v: string) => hiddenNeighbors(d, d.views[v], 'a', 'in').map(n => [n.instance.id, n.relations.map(r => r.id)]);
        expect(out('V3')).toEqual([['b', ['ab']]]);
        expect(out('V1')).toEqual([]);
        expect(inc('V3')).toEqual([['c', ['ca', 'ca2']]]);
        // A concept row of a scheme card counts as shown.
        d.shapes.valueSets.s = { id: 's', uri: 'urn:s', kind: 'scheme', label: 'Scheme', file: 'data.ttl', members: [{ uri: 'urn:c', label: 'C' }] };
        d.views.V3.boxes.push({ kind: 'card', id: 's', element: 's', ...box });
        expect(inc('V3')).toEqual([]);
    });

    it('element kind: view-owned elements only in their view', () => {
        const d = doc();
        expect(['a', 'ab', 'V1', 'g', 'n', 'x'].map(id => kindOf(d, d.views.V1, id))).toEqual(['instance', 'relation', 'view', 'group', 'note', undefined]);
        expect(kindOf(d, d.views.V2, 'g')).toBeUndefined();
    });

    it('kind name: the class of an instance, a fixed name for other kinds', () => {
        const d = doc();
        d.instances.a.types = ['urn:C'];
        const meta = { classes: [{ iri: 'urn:C', name: 'Book', fields: [], relations: [], unsupported: [] }] } as unknown as Parameters<typeof kindName>[1];
        expect(['a', 'b', 'ab', 'V1', 'g', 'n', 'x'].map(id => kindName(d, meta, id, d.views.V1))).toEqual(['Book', 'Instance', 'Relation', 'View', 'Group', 'Note', undefined]);
    });

    it('group of a box: the smallest group that contains the whole box', () => {
        const outer = { kind: 'group' as const, id: 'outer', label: 'O', x: 0, y: 0, width: 500, height: 500 };
        const inner = { kind: 'group' as const, id: 'inner', label: 'I', x: 10, y: 10, width: 200, height: 200 };
        const v = view('V', [], { boxes: [outer, inner] });
        expect(groupOf(v, { x: 20, y: 20, width: 50, height: 50 }, 'c')?.id).toBe('inner');
        // The center is in `inner`, but the box is not: `outer` holds it.
        expect(groupOf(v, { x: 150, y: 150, width: 100, height: 100 }, 'c')?.id).toBe('outer');
        expect(groupOf(v, inner, 'inner')?.id).toBe('outer');
        expect(groupOf(v, outer, 'outer')).toBeUndefined();
    });

    it('labels are the same text everywhere', () => {
        const d = doc();
        const meta = { classes: [] };
        expect(relationLabel(d, meta, 'ab')).toBe('A — p → B');
        expect(elementLabel(d, meta, 'ab')).toBe('A — p → B');
        expect(elementLabel(d, meta, 'n', d.views.V1)).toBe('first');
        expect(elementLabel(d, meta, 'V3')).toBe('V3');
    });
});
