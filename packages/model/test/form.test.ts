import { describe, expect, it } from 'vitest';
import { describeQuads } from '../src';

const node = (value: string) => ({ termType: 'NamedNode', value });
const S = 'https://example.org/attribution';
const AGENT = 'http://www.w3.org/ns/prov#agent';
const ROLE = 'http://www.w3.org/ns/prov#hadRole';

describe('form description', () => {
    // law_formSavesAbsoluteIrisOnly
    it('describeQuads drops a relative IRI object (a node that the form invented) and keeps a valid sibling', () => {
        const quads = [
            { subject: node(S), predicate: node(AGENT), object: node('3bc012f0-d183-4fa3-ac40-f5ab49ee2a75') },
            { subject: node(S), predicate: node(ROLE), object: node('https://example.org/owner') }
        ];
        expect(describeQuads(quads, S, [AGENT, ROLE])).toEqual({
            [AGENT]: [],
            [ROLE]: [{ termType: 'NamedNode', value: 'https://example.org/owner' }]
        });
    });
});
