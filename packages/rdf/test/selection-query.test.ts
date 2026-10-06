import { expect, it } from 'vitest';
import { NS, iriId } from '@catenary/model';
import { load } from './helpers';
import { selected } from '../src/selection';
import { readShapes } from '../src/shapes-read';
import { rdf } from '../src/terms';

const text = `
<urn:data> { <urn:a> a <urn:Type> . <urn:b> a <urn:Type> . <urn:c> a <urn:Type> . }
<urn:v1> {
    <urn:v1> a <${NS.view}View> .
    <urn:p1> a <${NS.view}Placement> ; <${NS.view}element> <urn:a> .
    <urn:p2> a <${NS.view}Placement> ; <${NS.view}element> <urn:b> .
    <urn:p3> a <${NS.view}Placement> ; <${NS.view}element> <urn:c> .
}
<urn:v2> {
    <urn:v2> a <${NS.view}View> .
    <urn:p4> a <${NS.view}Placement> ; <${NS.view}element> <urn:a> .
    <urn:p5> a <${NS.view}Placement> ; <${NS.view}element> <urn:c> .
}
<urn:trellis:validation> { <urn:ghost> a <urn:Type> . }
`;

it('resolves three placements to elements, and two placements of another view to the same elements', async () => {
    const g = await load(text), index = readShapes([]);
    const a = selected(g, index, { view: iriId('urn:v1'), ids: ['urn:p1', 'urn:p2', 'urn:p3'].map(iriId) });
    expect(a.ids).toEqual(['urn:p1', 'urn:p2', 'urn:p3'].map(iriId));
    expect(a.elements).toEqual(['urn:a', 'urn:b', 'urn:c'].map(iriId));
    expect(a.instances).toEqual(a.elements);
    const b = selected(g, index, { view: iriId('urn:v2'), ids: ['urn:p4', 'urn:p5'].map(iriId) });
    expect(b.elements).toEqual(['urn:a', 'urn:c'].map(iriId));
    expect(selected(g, index, { ids: a.elements }).elements).toEqual(a.elements);
});

it('drops deleted and report-only elements without consulting a Doc', async () => {
    const g = await load(text), index = readShapes([]);
    for (const q of g.match(rdf.namedNode('urn:b'))) g.store.delete(q);
    expect(selected(g, index, { ids: ['urn:a', 'urn:b', 'urn:ghost'].map(iriId) }).ids).toEqual([iriId('urn:a')]);
    expect(selected(g, index, { view: iriId('urn:missing'), ids: [iriId('urn:p1')] }).ids).toEqual([]);
});
