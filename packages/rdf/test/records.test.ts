import { describe, expect, it } from 'vitest';
import { project } from './project-full';
import { load } from './helpers';
import { projectReference } from './project-reference';
import { readView } from '../src/view-read';
import { readWarnings } from '../src/scoped-doc';
import { shapesIndexOf } from '../src/shapes-read';

// The records of the read models (records.ts) through the reads of the application: one view (view-read.ts) and the warnings of an
// open (scoped-doc.ts). Oracle: the match-based projection of the whole dataset (project-reference.ts, test only).

const ODD = `
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix dct: <http://purl.org/dc/terms/>.
@prefix view: <osg://vocab/view#>.
@prefix ex: <http://example.org/>.

<urn:name:model> {
    <urn:name:model> dct:conformsTo <osg://shapes/b>, <osg://shapes/a>; rdfs:label "The model".
    ex:a a ex:C, ex:B; rdfs:label "Zeta", "Alpha", "alpha"@en; ex:v "2", "10", 3, "x"@de; ex:bn [ ex:q 1 ]; ex:rel ex:b, ex:c; ex:link "ex:b".
    ex:b rdfs:label "Bee"; ex:rel ex:a; ex:bn2 _:x.
    ex:c a ex:C; ex:rel ex:a, ex:f.
    ex:f rdfs:label "Not in a view".
    ex:d ex:only "no type or label".
    ex:e rdfs:label ex:notALiteral.
    _:x ex:p "blank subject".
}

<urn:v:1> {
    <urn:v:1> a view:View; rdfs:label "View two", "View one".
    [] a view:Placement; view:element ex:a; view:x 10; view:y "20"; view:width 100; view:height 50; view:color "#fff".
    [] a view:Placement; view:element ex:b; view:x "abc"; view:y 5, 7.
    [] a view:Placement; view:element ex:a; view:x 99.
    [] a view:Placement; view:element ex:unknown.
    [] a view:Placement.
    [] a view:Placement; view:element ex:c; view:width 30.
    << ex:a ex:rel ex:b >> a view:Placement; view:fromSide "left"; view:toSide "nowhere"; view:color "red".
    << ex:a ex:rel ex:b >> a view:Placement; view:color "blue".
    << ex:b ex:rel ex:a >> a view:Placement.
    << ex:a ex:other ex:b >> a view:Placement.
    << ex:c ex:rel ex:a >> a view:Placement.
    << ex:c ex:rel ex:f >> a view:Placement.
    _:g2 a view:Frame; rdfs:label "G2". [] a view:Placement; view:element _:g2; view:x 0; view:y 0.
    _:g1 a view:Frame; rdfs:label "G1". [] a view:Placement; view:element _:g1; view:x 0; view:y 0; view:width 10; view:color "blue".
    _:g3 a view:Frame. [] a view:Placement; view:element _:g3; view:x 5; view:y -1; view:height 9.
}

<urn:v:0> {
    [] a view:View.
    [] a view:Placement; view:element ex:e.
}

<urn:g:other> {
    ex:a ex:p "not a view".
}
`;

describe('view reads and open warnings', () => {
    for (const [name, text] of [['the fixture model', undefined], ['a model with odd cases', ODD]] as const) {
        it(`each view read equals the view of the reference projection: ${name}`, async () => {
            const g = await load(text);
            const ref = projectReference(g);
            expect(Object.keys(ref.doc.views).length).toBeGreaterThan(0);
            for (const [id, view] of Object.entries(ref.doc.views)) expect(readView(g, id).views[id], id).toEqual(view);
        });
    }

    it('the warnings of an open name each case of the odd model; the read replaced its blank nodes by IRIs', async () => {
        const g = await load(ODD);
        const warnings = readWarnings(g, shapesIndexOf(g).model);
        for (const text of [
            'more than one rdfs:label', 'subject without rdf:type', 'statement about the model graph', 'has no view:View',
            'has no supported card presentation', 'placed twice', 'placement of an unknown relation'
        ]) expect(warnings.some(w => w.includes(text)), text).toBe(true);
        expect(g.quads().some(q => q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode')).toBe(false);
    });

    it('the test projection (project-full.ts) equals the reference projection', async () => {
        for (const text of [undefined, ODD]) {
            const g = await load(text);
            expect(JSON.stringify(project(g))).toEqual(JSON.stringify(projectReference(g)));
        }
    });
});
