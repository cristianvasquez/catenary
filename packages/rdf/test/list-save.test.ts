import { describe, expect, it } from 'vitest';
import { parseRdf, serializeRdf } from '../src/files';
import { canonical } from '../src/trig';
import { rdf } from '../src/terms';

// The shapes graphs keep RDF lists with IRI cells (skolem.ts). A save must not write such a list also as a "( … )" collection:
// that parses to a second, blank-node list and leaves the IRI cells without a reference (patch of @rdfjs/serializer-turtle 1.1.5).
const R = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const n = (v: string) => rdf.namedNode('http://ex/' + v);
const first = rdf.namedNode(R + 'first'), rest = rdf.namedNode(R + 'rest'), nil = rdf.namedNode(R + 'nil');

describe('saving RDF lists', () => {
    it.each(['/tmp/x.ttl', '/tmp/x.trig'])('keeps a list with IRI cells as statements (%s)', async file => {
        const quads = [
            rdf.quad(n('ps'), n('or'), n('c1')), rdf.quad(n('c1'), first, n('a')), rdf.quad(n('c1'), rest, n('c2')),
            rdf.quad(n('c2'), first, n('b')), rdf.quad(n('c2'), rest, nil)
        ];
        const text = await serializeRdf(quads, file);
        expect(text).not.toContain('(');
        expect(canonical(await parseRdf(text, file))).toBe(canonical(quads));
    });

    it('writes a list with blank cells as a collection', async () => {
        const b1 = rdf.blankNode('b1'), b2 = rdf.blankNode('b2');
        const quads = [rdf.quad(n('ps'), n('or'), b1), rdf.quad(b1, first, n('a')), rdf.quad(b1, rest, b2), rdf.quad(b2, first, n('b')), rdf.quad(b2, rest, nil)];
        const text = await serializeRdf(quads, '/tmp/x.ttl');
        expect(text).toMatch(/\(<http:\/\/ex\/a> <http:\/\/ex\/b>\)/);
        expect(canonical(await parseRdf(text, '/tmp/x.ttl'))).toBe(canonical(quads));
    });
});
