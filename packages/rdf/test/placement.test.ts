import { describe, expect, it } from 'vitest';
import { NS } from '@catenary/model';
import { fileGraphIri } from '../src/graph';
import { filesOfSubject, nearFiles, placeOf } from '../src/placement';
import { rdf, tripleKey } from '../src/terms';
import { emptyGraph } from './helpers';

const EX = 'http://example.org/';
const n = (l: string) => rdf.namedNode(EX + l);
const type = rdf.namedNode(NS.rdf + 'type');

/** A dataset and its origin: each statement of the model graph in the given files. */
function setup(statements: [string, string, string, string[]][]) {
    const g = emptyGraph();
    const origin = new Map<string, Set<string>>();
    for (const [s, p, o, files] of statements) {
        const q = rdf.quad(n(s), p === 'a' ? type : n(p), n(o), g.model);
        g.store.add(q);
        origin.set(tripleKey(q), new Set(files));
    }
    return { g, origin };
}

describe('placement', () => {
    it('the files of a subject, most statements first', () => {
        const { g, origin } = setup([['a', 'a', 'C', ['x.ttl']], ['a', 'p', 'b', ['y.ttl']], ['a', 'q', 'b', ['y.ttl']]]);
        expect(filesOfSubject(g, origin, n('a'))).toEqual(['y.ttl', 'x.ttl']);
    });

    it('a subject without statements: the file of a statement that refers to it', () => {
        const { g, origin } = setup([['a', 'p', 'b', ['x.ttl']]]);
        expect(nearFiles(g, origin, n('b'))).toEqual(new Set(['x.ttl']));
        expect(nearFiles(g, origin, n('c'))).toBeUndefined();
    });

    it('a shape: the file of its shapes graph', () => {
        const { g, origin } = setup([]);
        const graph = rdf.namedNode(fileGraphIri('/w/shapes.ttl'));
        g.setShapesGraphs([graph]);
        g.store.add(rdf.quad(n('S'), type, rdf.namedNode(NS.sh + 'NodeShape'), graph));
        expect(filesOfSubject(g, origin, n('S'))).toEqual(['/w/shapes.ttl']);
    });

    it('near: the file with most subjects of the class; a concept: the file of its scheme; else the placement file', () => {
        const { g, origin } = setup([
            ['i1', 'a', 'C', ['x.ttl']], ['i2', 'a', 'C', ['y.ttl']], ['i3', 'a', 'C', ['y.ttl']], ['new', 'a', 'C', []],
            ['s', 'a', 'S', ['v.ttl']]
        ]);
        g.store.add(rdf.quad(n('k'), type, rdf.namedNode(NS.skos + 'Concept'), g.model));
        g.store.add(rdf.quad(n('k'), rdf.namedNode(NS.skos + 'inScheme'), n('s'), g.model));
        const placement = { shapes: 'near', concepts: 'near', instances: 'near' };
        const placeFile = (f: string | undefined) => f ?? 'default.ttl';
        expect(placeOf(g, origin, placement, placeFile, n('new'))).toBe('y.ttl');
        expect(placeOf(g, origin, placement, placeFile, n('k'))).toBe('v.ttl');
        expect(placeOf(g, origin, placement, placeFile, n('nothing'))).toBe('default.ttl');
        expect(placeOf(g, origin, { ...placement, instances: 'fixed.ttl' }, placeFile, n('new'))).toBe('fixed.ttl');
    });
});
