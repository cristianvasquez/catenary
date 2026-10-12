import * as ox from 'oxigraph';
import { describe, expect, it } from 'vitest';
import type { ExplorerPort, QueryTerm } from '@catenary/contracts';
import { shaclRelated } from '@catenary/shacl/backend';

const EX = 'http://example.org/';
const GRAPH = EX + 'shapes';
const SHAPES = `
@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix ex: <${EX}> .
ex:S1 a sh:NodeShape ; sh:targetClass ex:A .
ex:S2 a sh:NodeShape ; sh:targetClass ex:A .
ex:S3 a sh:NodeShape ; sh:targetClass ex:B .
ex:A a rdfs:Class, sh:NodeShape .
ex:Other ex:p ex:o .
`;

/** A port over one graph. The element id of an IRI is 'id:' + IRI. */
function port(): ExplorerPort {
    const store = new ox.Store();
    store.load(SHAPES, { format: 'text/turtle', to_graph_name: ox.namedNode(GRAPH) });
    const memo = new Map<string, unknown>();
    return {
        select: query => (store.query(query) as Map<string, QueryTerm>[]).map(b => Object.fromEntries(b)),
        graph: (pattern, v = '?g') => `VALUES ${v} { <${GRAPH}> } GRAPH ${v} { ${pattern} }`,
        labels: iris => new Map(iris.map(i => [i, i])),
        compact: iri => iri.startsWith(EX) ? 'ex:' + iri.slice(EX.length) : iri,
        id: iri => 'id:' + iri,
        memo: <T>(key: string, compute: () => T) => (memo.has(key) ? memo.get(key) : memo.set(key, compute()).get(key)) as T
    };
}

const rows = (selected: string[]) => shaclRelated.related(port(), selected.map(s => 'id:' + EX + s))
    .flatMap(s => s.rows.map(r => `${s.key} ${r.element.slice(3 + EX.length)} ${r.description}`));

describe('Same target class (ui-manifest §8.8 law_sameTargetClass)', () => {
    it('gives the other node shapes with a target class of the selected shape, by both target forms', () => {
        expect(rows(['S1'])).toEqual(['same-target-class A ex:A', 'same-target-class S2 ex:A']);
    });

    it('an implicit class-target shape gives the explicit ones', () => {
        expect(rows(['A'])).toEqual(['same-target-class S1 ex:A', 'same-target-class S2 ex:A']);
    });

    it('law_sameTargetClass: a selected shape is never in its section, and the relation is symmetric', () => {
        const all = ['S1', 'S2', 'S3', 'A'];
        const related = (s: string) => rows([s]).map(r => r.split(' ')[1]);
        for (const a of all) {
            expect(related(a)).not.toContain(a);
            for (const b of all) expect(related(a).includes(b)).toBe(related(b).includes(a));
        }
        expect(rows(['S1', 'S2'])).toEqual(['same-target-class A ex:A']);
    });

    it('gives no section for a shape without a shared class or for a selection without a node shape', () => {
        expect(shaclRelated.related(port(), ['id:' + EX + 'S3'])).toEqual([]);
        expect(shaclRelated.related(port(), ['id:' + EX + 'Other'])).toEqual([]);
    });
});
