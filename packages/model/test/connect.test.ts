// Targets of connect gestures: the predicates that decide both the dimming and the drop (canvas.ts dragLine).
import { describe, expect, it } from 'vitest';
import { arrowProblem, reconnectProblem } from '../src/commands';
import { emptyDoc, type Doc, type Instance, type View } from '../src/doc';
import type { Classes } from '../src/metamodel';
import { broaderProblem, conceptParents, emptyShapes, isValueSetMember, propertyTargetProblem, rangeOfShape, type ShapesModel } from '../src/shapes-doc';

const KNOWS = 'urn:knows';
const meta: Classes = { classes: [
    { iri: 'urn:Person', name: 'Person', shapes: [], fields: [], unsupported: [], color: '', labelInShape: false,
        relations: [{ path: KNOWS, name: 'knows', targetClass: 'urn:Person' }] },
    { iri: 'urn:Book', name: 'Book', shapes: [], fields: [], unsupported: [], color: '', labelInShape: false, relations: [] },
] };
const instance = (id: string, type: string): Instance => ({ id, label: id, types: [type], uri: `urn:${id}`, fields: {} });

describe('reconnectProblem', () => {
    const doc: Doc = emptyDoc();
    for (const i of [instance('alice', 'urn:Person'), instance('bob', 'urn:Person'), instance('carol', 'urn:Person'), instance('dune', 'urn:Book')]) doc.instances[i.id] = i;
    const r = { id: 'r1', subject: 'alice', predicate: KNOWS, object: 'bob' };
    doc.relations.r1 = r;
    doc.relations.r2 = { id: 'r2', subject: 'alice', predicate: KNOWS, object: 'carol' };

    it('accepts the same instance (side only) and a permitted new end', () => {
        expect(reconnectProblem(meta, doc, r, 'target', 'bob')).toBeUndefined();
        expect(reconnectProblem(meta, doc, r, 'source', 'carol')).toBeUndefined();
    });

    it('refuses a loop, a type the shapes do not permit, a duplicate and a missing instance', () => {
        expect(reconnectProblem(meta, doc, r, 'target', 'alice')).toMatch(/itself/);
        expect(reconnectProblem(meta, doc, r, 'target', 'dune')).toMatch(/rule permits this relation/);
        expect(reconnectProblem(meta, doc, r, 'target', 'carol')).toMatch(/exists already/);
        expect(reconnectProblem(meta, doc, r, 'target', 'nobody')).toMatch(/two instances/);
    });
});

describe('arrowProblem', () => {
    // A card has a placement id other than its instance id; arrow ends are box ids (the card: its placement).
    const box = { x: 0, y: 0, width: 10, height: 10 };
    const view = {
        id: 'v', label: 'v', uri: 'urn:v', edges: [],
        boxes: [{ ...box, id: 'p-alice', kind: 'card', element: 'alice' }, { ...box, id: 'p-bob', kind: 'card', element: 'bob' },
            { ...box, id: 'n1', kind: 'note', text: '' }, { ...box, id: 'n2', kind: 'note', text: '' }],
        arrows: [{ id: 'a1', from: 'n1', to: 'p-alice' }],
    } as unknown as View;

    it('needs a note at one end, two different ends and no same arrow', () => {
        expect(arrowProblem(view, 'n1', 'bob')).toBeUndefined();
        expect(arrowProblem(view, 'alice', 'n2')).toBeUndefined();
        expect(arrowProblem(view, 'n1', 'n1')).toMatch(/different/);
        expect(arrowProblem(view, 'alice', 'bob')).toMatch(/note/);
    });

    it('finds an existing arrow to a card by its instance id or its placement id', () => {
        expect(arrowProblem(view, 'n1', 'alice')).toMatch(/exists already/);
        expect(arrowProblem(view, 'n1', 'p-alice')).toMatch(/exists already/);
    });
});

describe('broaderProblem', () => {
    const shapes: ShapesModel = emptyShapes();
    shapes.valueSets.s = { id: 's', uri: 'urn:s', kind: 'scheme', label: 's', file: '', members: [
        { uri: 'urn:a', label: 'a' }, { uri: 'urn:b', label: 'b', broader: ['urn:a'] }, { uri: 'urn:c', label: 'c', broader: ['urn:b'] },
        { uri: 'urn:d', label: 'd', broader: ['urn:x'] },
    ] };
    // urn:x is in no value set; its broader concept urn:a comes from the vocabulary.
    const parents = conceptParents(shapes, [{ iri: 'urn:x', broader: ['urn:a'] }]);
    const problem = (uri: string, broader: string) => broaderProblem(uri, broader, u => isValueSetMember(shapes, u), parents);

    it('accepts a concept of a value set that is not below the dragged one', () => {
        expect(problem('urn:c', 'urn:a')).toBeUndefined();
    });

    it('refuses itself, a narrower concept (cycle) and a concept outside the value sets', () => {
        expect(problem('urn:a', 'urn:a')).toMatch(/itself/);
        expect(problem('urn:a', 'urn:c')).toMatch(/itself/);
        expect(problem('urn:a', 'urn:x')).toMatch(/Both concepts/);
    });

    it('finds a cycle through a concept that is in no value set', () => {
        expect(problem('urn:a', 'urn:d')).toMatch(/itself/);
    });
});

describe('propertyTargetProblem', () => {
    const shapes: ShapesModel = emptyShapes();
    shapes.nodeShapes.person = { id: 'person', uri: 'urn:PersonShape', label: 'Person', targetClass: 'urn:Person', file: '', properties: [], constraints: [] } as unknown as ShapesModel['nodeShapes'][string];
    shapes.nodeShapes.book = { id: 'book', uri: 'urn:BookShape', label: 'Book', targetClass: 'urn:Book', file: '', properties: [], constraints: [] } as unknown as ShapesModel['nodeShapes'][string];

    it('accepts a node shape, also the own one, that is not a current target', () => {
        expect(propertyTargetProblem(shapes, 'person')).toBeUndefined();
        const toBook = rangeOfShape(shapes, 'book')!;
        expect(propertyTargetProblem(shapes, 'person', [toBook])).toBeUndefined();
        expect(propertyTargetProblem(shapes, 'book', [toBook])).toMatch(/already/);
        expect(propertyTargetProblem(shapes, 'book', [{ kind: 'or', alternatives: [toBook as never] }])).toMatch(/already/);
    });

    it('refuses a card that is no node shape or value set', () => {
        expect(propertyTargetProblem(shapes, 'alice')).toMatch(/node shape, a concept scheme or a collection/);
    });
});
