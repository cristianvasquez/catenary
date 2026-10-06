import { describe, expect, it } from 'vitest';
import { NS, iriId } from '@catenary/model';
import { executeCommand } from '../src/commands';
import { P } from '../src/graph';
import { relationId } from '../src/ids';
import { rdf } from '../src/terms';
import { canonical } from '../src/trig';
import { doc, load } from './helpers';

const EX = 'http://example.org/';
const TEXT = `
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix sh: <http://www.w3.org/ns/shacl#>.
@prefix skos: <http://www.w3.org/2004/02/skos/core#>.
@prefix view: <osg://vocab/view#>.
@prefix ex: <${EX}>.
<urn:name:model> {
    ex:a a ex:C; rdfs:label "A".
    ex:b a ex:C; rdfs:label "B"; ex:rel ex:a.
    ex:both a ex:C; rdfs:label "Both"; skos:prefLabel "Both".
    ex:s a skos:ConceptScheme; skos:prefLabel "S"; skos:hasTopConcept ex:row.
}
<urn:file:/s.ttl> { ex:CShape a sh:NodeShape; sh:targetClass ex:C; sh:name "C shape". }
<urn:v:1> { <urn:v:1> a view:View; rdfs:label "V". <urn:v:1-node> a view:Placement; view:element ex:a. <urn:v:1-node-2> a view:Placement; view:element ex:CShape. }
<urn:v:2> { <urn:v:2> a view:View; rdfs:label "W". <urn:v:2-ref> a view:Placement; view:element <urn:v:1>; view:x 0; view:y 0. }
`;
const meta = { classes: [] };
const id = (local: string) => iriId(EX + local);

describe('elements of any kind', () => {
    it('deletes an instance, a relation, a node shape and a view in one command and one undo step', async () => {
        const g = await load(TEXT);
        const before = canonical(g.quads());
        const rel = relationId(rdf.namedNode(EX + 'b'), rdf.namedNode(EX + 'rel'), rdf.namedNode(EX + 'a'));
        const { result, patch } = g.transact(x => executeCommand(x, meta, { kind: 'delete', ids: [id('a'), rel, id('CShape'), iriId('urn:v:2')] }));
        expect(result.ok).toBe(true);
        const d = doc(g);
        expect(Object.values(d.instances).map(i => i.label).sort()).toEqual(['B', 'Both', 'S']);
        expect(d.relations).toEqual({});
        expect(d.shapes.nodeShapes).toEqual({});
        expect(Object.values(d.views).map(v => [v.label, v.boxes.length])).toEqual([['V', 0]]);
        g.undo(patch);
        expect(canonical(g.quads())).toBe(before);
        expect(g.transact(x => executeCommand(x, meta, { kind: 'delete', ids: ['n-missing'] })).result.ok).toBe(false);
    });

    it('renames with the label predicates the element has, else the default of its kind', async () => {
        const g = await load(TEXT);
        const label = (s: string, p: string) => g.match(rdf.namedNode(s), rdf.namedNode(p)).map(q => q.object.value);
        for (const [target, name] of [[id('both'), 'Both 2'], [id('CShape'), 'Shape 2'], [id('s'), 'S 2'], [iriId('urn:v:1'), 'V 2'], [id('row'), 'Row']]) {
            expect(g.transact(x => executeCommand(x, meta, { kind: 'rename', id: target, label: name })).result.ok, target).toBe(true);
        }
        expect([label(EX + 'both', P.label.value), label(EX + 'both', NS.skos + 'prefLabel')]).toEqual([['Both 2'], ['Both 2']]);
        expect([label(EX + 'CShape', NS.sh + 'name'), label(EX + 'CShape', P.label.value)]).toEqual([['Shape 2'], []]);
        expect([label(EX + 's', NS.skos + 'prefLabel'), label(EX + 's', P.label.value)]).toEqual([['S 2'], []]);
        expect(label('urn:v:1', P.label.value)).toEqual(['V 2']);
        // A concept that is only a row of its scheme gets skos:prefLabel in the data file.
        expect(doc(g).shapes.valueSets[id('s')].members.map(m => m.label)).toEqual(['Row']);
        expect(g.transact(x => executeCommand(x, meta, { kind: 'rename', id: id('a'), label: ' ' })).result.ok).toBe(false);
        expect(g.transact(x => executeCommand(x, meta, { kind: 'rename', id: id('nothing'), label: 'X' })).result.ok).toBe(false);
    });
});
