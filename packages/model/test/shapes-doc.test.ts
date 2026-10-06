import { expect, it } from 'vitest';
import { NodeShape, Range, classIri, emptyShapes, iriText, parseIri, rangeOfShape } from '../src';

it.each<[string, Range | undefined]>([
    ['classShape', { kind: 'class', class: 'urn:Class' }],
    ['nodeShape', { kind: 'node', shape: 'nodeShape' }],
    ['scheme', { kind: 'scheme', schemes: ['urn:scheme'] }],
    ['collection', { kind: 'collection', collection: 'urn:collection' }],
    ['property', undefined],
    ['missing', undefined]
])('range of card %s', (id, expected) => {
    const shapes = emptyShapes();
    const node = (id: string, targetClass?: string): NodeShape => ({
        id, uri: `urn:${id}`, label: id, targetClass, file: '', properties: [], constraints: [], raw: []
    });
    shapes.nodeShapes.classShape = node('classShape', 'urn:Class');
    shapes.nodeShapes.nodeShape = node('nodeShape');
    for (const kind of ['scheme', 'collection'] as const) {
        shapes.valueSets[kind] = { id: kind, uri: `urn:${kind}`, kind, label: kind, file: '', members: [] };
    }
    shapes.properties.property = { id: 'property', owner: 'nodeShape', path: { kind: 'iri', iri: 'urn:p' }, range: { kind: 'any' }, raw: [] };
    expect(rangeOfShape(shapes, id)).toEqual(expected);
});

it.each<[string, ReturnType<typeof parseIri>]>([
    ['', {}],
    ['dcat:Dataset', { iri: 'http://www.w3.org/ns/dcat#Dataset' }],
    ['<mailto:a@b.c>', { iri: 'mailto:a@b.c' }],
    ['https://example.org/x', { iri: 'https://example.org/x' }],
    ['urn:name:Cat', { iri: 'urn:name:Cat' }],
    ['My Thing', { iri: 'urn:name:My%20Thing' }]
])('IRI field input %j', (text, expected) => {
    expect(parseIri(text)).toEqual(expected);
});

it('IRI field input with an unknown prefix is an error, not a name', () => {
    expect(parseIri('ex:Foo')).toHaveProperty('error', expect.stringContaining('Unknown prefix "ex:"'));
});

it.each(['http://www.w3.org/ns/dcat#Dataset', 'https://example.org/x', 'urn:name:My%20Thing', 'mailto:a@b.c'])('IRI field text of %s reads back', iri => {
    expect(parseIri(iriText(iri))).toEqual({ iri });
});

it('a typed class name resolves to the known class with that name; an IRI stays; an unknown name is a urn:name', () => {
    const UI = 'osg://vocab/trellis-ui#';
    const known = [{ iri: UI + 'Surface', name: 'Surface' }, { iri: UI + 'Section' }, { iri: 'http://example.org/a#Item' }, { iri: 'http://example.org/b#Item' }];
    // The name of the class, as instance cards show it: the existing class, not a new urn:name IRI.
    expect(classIri('Surface', known)).toEqual({ iri: UI + 'Surface' });
    expect(classIri(' Section ', known)).toEqual({ iri: UI + 'Section' });
    expect(classIri('dcat:Dataset', known)).toEqual({ iri: 'http://www.w3.org/ns/dcat#Dataset' });
    expect(classIri('<urn:x:Surface>', known)).toEqual({ iri: 'urn:x:Surface' });
    expect(classIri('Unknown', known)).toEqual({ iri: 'urn:name:Unknown' });
    expect(classIri('Item', known)).toEqual({ error: expect.stringContaining('More than one class is named "Item"') });
    expect(classIri('  ', known)).toBeUndefined();
});
