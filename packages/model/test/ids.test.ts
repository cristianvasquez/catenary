// canonicalId and the laws of manifest §1.3: law_iriIdDisjoint, law_canonicalIdIdempotent.
import { describe, expect, it } from 'vitest';
import { canonicalId, escapeId, iriId, relationIdOf } from '../src/ids';

const IRIS = ['urn:name:MEPS%20mirror', 'http://www.w3.org/ns/dcat#Dataset', 'dcat:Dataset', 'osg://vocab/x#y', 'urn:a:ünï cødé/?#'];
const ID = /^[A-Za-z0-9_-]+$/;

describe('canonicalId', () => {
    it('an IRI gives its element id; a CURIE is an IRI', () => {
        expect(canonicalId('urn:name:MEPS%20mirror')).toBe('n-urn_3aname_3aMEPS_2520mirror');
        expect(canonicalId('dcat:Dataset')).toBe(iriId('dcat:Dataset'));
    });

    it('a triple gives its relation id', () => {
        expect(canonicalId({ s: 'urn:a', p: 'urn:p', o: 'urn:b' })).toBe(`r-${escapeId('urn:a')}-${escapeId('urn:p')}-${escapeId('urn:b')}`);
        expect(canonicalId({ s: 'urn:a', p: 'urn:p', o: 'urn:b' })).toBe(relationIdOf('urn:a', 'urn:p', 'urn:b'));
    });

    it('an id stays the same', () => {
        for (const id of ['n-urn_3aname_3aX', 'r-a-b-c', 'p-x-y-z-2', 'c-or-x-1', 'n-x_leaf']) expect(canonicalId(id)).toBe(id);
    });

    it('law_iriIdDisjoint: an id has no ":", an IRI has one', () => {
        for (const iri of IRIS) {
            expect(iri).toContain(':');
            const ids = [iriId(iri), relationIdOf(iri, iri, iri)];
            for (const id of ids) {
                expect(id).toMatch(ID);
                expect(id).not.toBe(iri);
            }
        }
    });

    it('law_canonicalIdIdempotent', () => {
        const values = [...IRIS, ...IRIS.map(iriId), 'r-a-b-c', ...IRIS.map(s => ({ s, p: s, o: s }))];
        for (const x of values) expect(canonicalId(canonicalId(x))).toBe(canonicalId(x));
    });
});
