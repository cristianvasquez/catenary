import { expect, it } from 'vitest';
import { sourceLine } from '../src/files';

const TTL = `@prefix ex: <http://example.org/> .
@prefix : <http://example.org/base#> .

ex:A ex:knows ex:B .
<http://example.org/B> a ex:Thing .
ex:B2 a ex:Thing .
:C a ex:Thing .
`;

it.each<[string, number | undefined]>([
    ['http://example.org/A', 4],
    // The subject line wins over an earlier object position.
    ['http://example.org/B', 5],
    ['http://example.org/B2', 6],
    ['http://example.org/base#C', 7],
    ['http://example.org/Thing', 5],
    ['http://example.org/missing', undefined]
])('line of %s in Turtle', (iri, line) => {
    expect(sourceLine(TTL, iri)).toBe(line);
});

it('finds indented subjects in TriG graphs and IRIs in JSON-LD', () => {
    expect(sourceLine('PREFIX ex: <http://example.org/>\n<urn:g> {\n    ex:A a ex:T .\n}\n', 'http://example.org/A')).toBe(3);
    expect(sourceLine('[\n  {\n    "@id": "http://example.org/A"\n  }\n]\n', 'http://example.org/A')).toBe(3);
});
