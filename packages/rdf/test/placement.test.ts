import { describe, expect, it } from 'vitest';
import { NS } from '@catenary/model';
import { dataGraphIri, fileGraphIri } from '../src/graph';
import { filesOfSubject, nearFiles, placeOf } from '../src/placement';
import { rdf, tripleKey } from '../src/terms';
import { emptyGraph } from './helpers';

const EX = 'http://example.org/';
const n = (l: string) => rdf.namedNode(EX + l);
const type = rdf.namedNode(NS.rdf + 'type');

/** A dataset with each statement in the given file data graphs. */
function setup(statements: [string, string, string, string[]][]) {
    const g = emptyGraph();
    g.setDataGraphs([...new Set(statements.flatMap(s => s[3]))].map(f => rdf.namedNode(dataGraphIri(f))));
    for (const [s, p, o, files] of statements) {
        for (const graph of files.length ? files.map(f => rdf.namedNode(dataGraphIri(f))) : [g.model]) g.add(n(s), p === 'a' ? type : n(p), n(o), graph);
    }
    return { g };

}

describe('placement', () => {
    it('the files of a subject, most statements first', () => {
        const { g } = setup([['a', 'a', 'C', ['x.ttl']], ['a', 'p', 'b', ['y.ttl']], ['a', 'q', 'b', ['y.ttl']]]);
        expect(filesOfSubject(g, n('a'))).toEqual(['y.ttl', 'x.ttl']);
    });

    it('a subject without statements: the file of a statement that refers to it', () => {
        const { g } = setup([['a', 'p', 'b', ['x.ttl']]]);
        expect(nearFiles(g, n('b'))).toEqual(new Set(['x.ttl']));
        expect(nearFiles(g, n('c'))).toBeUndefined();
    });

    it('a shape: the file of its shapes graph', () => {
        const { g } = setup([]);
        const graph = rdf.namedNode(fileGraphIri('/w/shapes.ttl'));
        g.setShapesGraphs([graph]);
        g.store.add(rdf.quad(n('S'), type, rdf.namedNode(NS.sh + 'NodeShape'), graph));
        expect(filesOfSubject(g, n('S'))).toEqual(['/w/shapes.ttl']);
    });

    it('near: the file with most subjects of the class; a concept: the file of its scheme; else the placement file', () => {
        const { g } = setup([
            ['i1', 'a', 'C', ['x.ttl']], ['i2', 'a', 'C', ['y.ttl']], ['i3', 'a', 'C', ['y.ttl']], ['new', 'a', 'C', []],
            ['s', 'a', 'S', ['v.ttl']]
        ]);
        g.store.add(rdf.quad(n('k'), type, rdf.namedNode(NS.skos + 'Concept'), g.model));
        g.store.add(rdf.quad(n('k'), rdf.namedNode(NS.skos + 'inScheme'), n('s'), g.model));
        const placement = { shapes: 'near', concepts: 'near', instances: 'near' };
        const placeFile = (f: string | undefined) => f ?? 'default.ttl';
        expect(placeOf(g, placement, placeFile, n('new'))).toBe('y.ttl');
        expect(placeOf(g, placement, placeFile, n('k'))).toBe('v.ttl');
        expect(placeOf(g, placement, placeFile, n('nothing'))).toBe('default.ttl');
        expect(placeOf(g, { ...placement, instances: 'fixed.ttl' }, placeFile, n('new'))).toBe('fixed.ttl');
    });
});
