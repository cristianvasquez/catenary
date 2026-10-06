import { describe, expect, it } from 'vitest';
import { Doc, TYPES, Violation, toSchema, emptyShapes, boxes } from '../src';

function document(): Doc {
    const instances = Object.fromEntries(['a', 'b', 'outside'].map(id => [id, {
        id, uri: `urn:${id}`, label: id, types: ['urn:Unknown'], fields: {}
    }]));
    return {
        instances,
        relations: {
            ab: { id: 'ab', subject: 'a', predicate: 'urn:rel', object: 'b' },
            ba: { id: 'ba', subject: 'b', predicate: 'urn:rel', object: 'a' },
            outside: { id: 'outside', subject: 'a', predicate: 'urn:rel', object: 'outside' }
        },
        views: {
            v: {
                id: 'v', uri: 'urn:v', label: 'View',
                boxes: ['a', 'b'].map(id => ({ kind: 'card', id, element: id, x: 10, y: 20, width: 320, height: 160 })),
                edges: [{ relation: 'ba', hidden: true }], arrows: []
            }
        },
        shapes: emptyShapes()
    };
}

const render = (doc: Doc, showHidden = false, violations: Violation[] = []) =>
    toSchema(doc, { classes: [] }, 'v', { showHidden, violations }).children!;

describe('diagram read model', () => {
    it('shows only placed instances and relations with both ends; hidden edges are opt-in', () => {
        const doc = document();
        const visible = render(doc);
        expect(visible.filter(e => e.type === TYPES.CARD).map(e => e.id)).toEqual(['a', 'b']);
        expect(visible.filter(e => e.type === TYPES.RELATION)).toMatchObject([
            { id: 'ab', sourceId: 'a', targetId: 'b', hidden: false, lanes: 1 }
        ]);
        const edges = render(doc, true).filter(e => e.type === TYPES.RELATION);
        expect(edges).toHaveLength(2);
        expect(edges).toMatchObject([{ id: 'ab', lane: 0, lanes: 2 }, { id: 'ba', hidden: true, lane: 1, lanes: 2 }]);
    });

    it('reflects a changed label and counts only violations belonging to the card', () => {
        const doc = document();
        const before = render(doc);
        doc.instances.a.label = 'Renamed';
        const violation = { focus: 'urn:a', component: 'MinCount', message: 'Required' };
        const after = render(doc, false, [
            { ...violation, instance: 'a', severity: 'Violation' },
            { ...violation, instance: 'a', severity: 'Warning' },
            { ...violation, instance: 'outside', severity: 'Violation' }
        ]);
        expect(before.find(e => e.id === 'a')!.name).toBe('a');
        expect(after.find(e => e.id === 'a')).toMatchObject({
            name: 'Renamed', known: false, violations: 1
        });
        expect(after.find(e => e.id === 'b')!.violations).toBe(0);
    });

    it('shows one card line when several property shapes constrain the same path', () => {
        const doc = document();
        doc.instances.a.types = ['urn:Known'];
        doc.instances.a.fields['urn:age'] = [{ termType: 'Literal', value: '22' }];
        const children = toSchema(doc, { classes: [{
            iri: 'urn:Known', name: 'Known', shapes: ['urn:Shape'], relations: [], unsupported: [], color: '1', labelInShape: false,
            fields: [
                { path: 'urn:age', name: 'age', datatype: 'http://www.w3.org/2001/XMLSchema#string', iri: false },
                { path: 'urn:age', name: 'age', datatype: 'http://www.w3.org/2001/XMLSchema#integer', iri: false }
            ]
        }] }, 'v', { showHidden: false, violations: [] }).children!;
        expect(children.find(e => e.id === 'a')!.lines).toEqual(['age: 22']);
    });

    it('a collection replaces its members\' cards; their relations become bundles with a count, none inside the collection', () => {
        const doc = document();
        doc.instances.c = { id: 'c', uri: 'urn:c', label: 'c', types: [], fields: {} };
        doc.relations.ac = { id: 'ac', subject: 'a', predicate: 'urn:rel', object: 'c' };
        doc.relations.bc = { id: 'bc', subject: 'b', predicate: 'urn:rel', object: 'c' };
        const v = doc.views.v;
        v.boxes.push({ kind: 'card', id: 'c', element: 'c', x: 0, y: 400, width: 320, height: 160 });
        v.boxes.push({ kind: 'collection', id: 'col', members: ['a', 'b'], x: 0, y: 0, width: 320, height: 240 });
        const children = render(doc, true);
        expect(children.filter(e => e.type === TYPES.CARD).map(e => e.id)).toEqual(['c']);
        expect(children.filter(e => e.type === TYPES.RELATION)).toEqual([]);
        expect(children.filter(e => e.type === TYPES.BUNDLE)).toMatchObject([{ id: 'ac_bundle', sourceId: 'col', targetId: 'c', count: 2, lanes: 1 }]);
        expect(children.find(e => e.type === TYPES.COLLECTION)).toMatchObject({ id: 'col', members: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }] });
    });

    it('does not leave cards or edges behind when their view is deleted', () => {
        const doc = document();
        delete doc.views.v;
        expect(render(doc)).toEqual([]);
    });
});

describe('card display', () => {
    it('passes the display of cards', () => {
        const doc = document();
        const v = doc.views.v;
        v.boxes = [
            { kind: 'card', id: 'a', element: 'a', x: 10, y: 20, width: 320, height: 160, display: 'simple' },
            { kind: 'card', id: 'b', element: 'b', x: 400, y: 20, width: 320, height: 160 },
        ];
        // A node shape card: notation-schema.test.ts (packages/rdf).
        const out = render(doc);
        const byId = Object.fromEntries(out.map(e => [e.id, e]));
        expect(byId.a).toMatchObject({ type: TYPES.CARD, display: 'simple' });
        expect(byId.b).toMatchObject({ type: TYPES.CARD, display: 'detailed' });
    });
});

describe('diagram ids: a placement is not its element (M1b)', () => {
    it('a card and a placed edge have the id of their placement; edge ends are the card placements; a hidden edge keeps the relation id', () => {
        const doc = document();
        doc.views.v.boxes = [
            { kind: 'card', id: 'pa', element: 'a', x: 10, y: 20, width: 320, height: 160 },
            { kind: 'card', id: 'pb', element: 'b', x: 500, y: 20, width: 320, height: 160 }
        ];
        doc.views.v.edges = [{ id: 'pab', relation: 'ab' }, { relation: 'ba', hidden: true }];
        const kids = render(doc, true);
        expect(kids.filter(k => k.type === TYPES.CARD).map(k => [k.id, k.element])).toEqual([['pa', 'a'], ['pb', 'b']]);
        const edges = kids.filter(k => k.type === TYPES.RELATION).map(k => [k.id, k.element, k.sourceId, k.targetId]);
        expect(edges).toEqual(expect.arrayContaining([['pab', 'ab', 'pa', 'pb'], ['ba', 'ba', 'pb', 'pa']]));
    });
});
