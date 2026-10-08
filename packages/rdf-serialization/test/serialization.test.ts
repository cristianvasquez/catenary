import rdfModule from 'rdf-ext';
import { describe, expect, it } from 'vitest';
import { canonicalNQuads, triplify } from '../src/index.js';

const rdf = rdfModule as any;
const ex = 'http://example.org/';

describe('vendored RDF serialization', () => {
    it('canonicalizes isomorphic blank-node datasets independent of labels and order', () => {
        const p = rdf.namedNode(ex + 'p');
        const first = [
            rdf.quad(rdf.blankNode('a'), p, rdf.blankNode('b')),
            rdf.quad(rdf.blankNode('b'), p, rdf.literal('value'))
        ];
        const second = [
            rdf.quad(rdf.blankNode('y'), p, rdf.literal('value')),
            rdf.quad(rdf.blankNode('x'), p, rdf.blankNode('y'))
        ];
        expect(canonicalNQuads(first)).toBe(canonicalNQuads(second));
    });

    it('serializes RDF 1.2 triple terms and directional literals', () => {
        const p = rdf.namedNode(ex + 'p');
        const quoted = rdf.quad(rdf.namedNode(ex + 's'), p, rdf.namedNode(ex + 'o'));
        const directed = rdf.literal('hello', { language: 'en', direction: 'ltr' });
        const quads = [
            rdf.quad(rdf.namedNode(ex + 'quoted'), p, quoted),
            rdf.quad(rdf.namedNode(ex + 'directional'), p, directed)
        ];
        const text = canonicalNQuads(quads);
        expect(text).toContain(`<<( <${ex}s> <${ex}p> <${ex}o> )>>`);
        expect(text).toContain('"hello"@en--ltr');
    });

    it('writes named graphs as TriG blocks that rdf-ext can parse', async () => {
        const quad = rdf.quad(rdf.namedNode(ex + 's'), rdf.namedNode(ex + 'p'), rdf.literal('value'), rdf.namedNode(ex + 'graph'));
        const text = await triplify([quad], { ex });
        expect(text).toContain(`<${ex}graph> {`);
        const roundTrip = await rdf.io.dataset.fromText('application/trig', text);
        expect([...roundTrip]).toHaveLength(1);
        expect([...roundTrip][0].graph.value).toBe(ex + 'graph');
    });

    it('does not write slashes inside prefixed names', async () => {
        const shape = rdf.namedNode(ex + 'shape');
        const defaultValue = rdf.namedNode('http://publications.europa.eu/resource/authority/language/ENG');
        const artifact = rdf.namedNode('http://example.org/contracts/dprod-contracts.ttl');
        const predicate = rdf.namedNode(ex + 'value');
        const text = await triplify([
            rdf.quad(shape, predicate, defaultValue),
            rdf.quad(shape, rdf.namedNode(ex + 'artifact'), artifact)
        ], {
            ex,
            atold: 'http://publications.europa.eu/resource/authority/',
            dproddev: 'http://example.org/'
        });

        expect(text).toContain(`<${defaultValue.value}>`);
        expect(text).toContain(`<${artifact.value}>`);
        expect(text).not.toContain('atold:language/ENG');
        expect(text).not.toContain('dproddev:contracts/');
        const roundTrip = await rdf.io.dataset.fromText('text/turtle', text);
        expect([...roundTrip]).toHaveLength(2);
    });
});
