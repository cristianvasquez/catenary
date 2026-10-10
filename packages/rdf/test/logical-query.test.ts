import { expect, it } from 'vitest';
import { OxigraphStore } from 'rdf-files';
import { ModelGraph, P, V } from '../src/graph';
import { rdf } from '../src/terms';
import { elementId } from '../src/ids';
import { readView } from '../src/view-read';

it('keeps placed instances when an IRI contains a quote before a logical GRAPH pattern (kata r5dd)', () => {
    const g = new ModelGraph(new OxigraphStore());
    const data = rdf.namedNode('urn:data:test');
    g.setDataGraphs([data]);
    const book = rdf.namedNode('urn:Book'), quoted = rdf.namedNode("urn:it's-an-element");
    const view = rdf.namedNode('urn:view:test');
    g.add(view, P.type, V.View, view);
    for (const [i, element] of [book, quoted].entries()) {
        g.add(element, P.type, rdf.namedNode('urn:Class'), data);
        g.add(element, P.label, rdf.literal(i ? 'Quoted' : 'Book'), data);
        const placement = rdf.namedNode(`urn:view:test/p/${i}`);
        g.add(placement, P.type, V.Placement, view);
        g.add(placement, V.element, element, view);
    }
    const warnings: string[] = [];
    const doc = readView(g, elementId(view), undefined, warnings);
    expect(doc.views[elementId(view)].boxes.map(b => b.kind === 'card' && b.element)).toEqual([elementId(book), elementId(quoted)]);
    expect(doc.instances[elementId(book)].types).toEqual(['urn:Class']);
    expect(doc.instances[elementId(quoted)].label).toBe('Quoted');
    expect(warnings).toEqual([]);
    expect(readView(g, elementId(view), undefined, [], [elementId(book)]).instances[elementId(book)]).toEqual(doc.instances[elementId(book)]);
});
