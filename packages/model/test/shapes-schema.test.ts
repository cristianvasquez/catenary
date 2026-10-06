// The parts of the SHACL elements that do not need the notation engine. What a view draws (notation-schema.ts, ADR 0014):
// packages/rdf/test/notation-schema.test.ts.

import { expect, it } from 'vitest';
import { Doc, Range, emptyDoc, hiddenShapeSources } from '../src';

function document(): Doc {
    const doc = emptyDoc();
    const cards = ['a', 'b', 'c'].map(id => ({ kind: 'card' as const, id, element: id, x: 0, y: 0, width: 260, height: 100 }));
    doc.views.v = { id: 'v', uri: 'urn:v', label: 'View', boxes: cards, edges: [], arrows: [] };
    for (const { id } of cards) {
        doc.shapes.nodeShapes[id] = { id, uri: `urn:${id}`, label: id, file: '', properties: [], constraints: [], raw: [] };
    }
    return doc;
}

function property(doc: Doc, id: string, owner: string, range: Range, out = true): void {
    doc.shapes.properties[id] = { id, owner, path: { kind: 'iri', iri: `urn:${id}` }, range, raw: [] };
    doc.shapes.nodeShapes[owner].properties.push(id);
    if (out) doc.views.v.boxes.push({ kind: 'card', id, element: id, x: 500, y: 200, width: 100, height: 26 });
}

it('lists hidden node shapes with a property to a node shape: sh:node, sh:class of its target class, "or" alternative', () => {
    const doc = document();
    doc.shapes.nodeShapes.a.targetClass = 'urn:A';
    for (const id of ['x', 'y', 'z']) doc.shapes.nodeShapes[id] = { id, uri: `urn:${id}`, label: id, file: '', properties: [], constraints: [], raw: [] };
    property(doc, 'y1', 'y', { kind: 'node', shape: 'a' }, false);
    property(doc, 'y2', 'y', { kind: 'class', class: 'urn:A' }, false);
    property(doc, 'x1', 'x', { kind: 'or', alternatives: [{ kind: 'datatype', datatype: 'urn:d' }, { kind: 'node', shape: 'a' }] }, false);
    property(doc, 'z1', 'z', { kind: 'class', class: 'urn:Other' }, false);
    property(doc, 'b1', 'b', { kind: 'node', shape: 'a' }, false); // b is in the view.
    property(doc, 'a1', 'a', { kind: 'node', shape: 'a' }, false); // Self-reference.
    const found = hiddenShapeSources(doc.shapes, doc.views.v, 'a');
    expect(found.map(n => [n.shape.id, n.properties.map(p => p.id)])).toEqual([['x', ['x1']], ['y', ['y1', 'y2']]]);
    expect(hiddenShapeSources(doc.shapes, doc.views.v, 'missing')).toEqual([]);
});
