import { describe, expect, it } from 'vitest';
import { turtlePosition } from 'rdf-files';

const TEXT = `@prefix ex: <http://example.org/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .

ex:other ex:link ex:a .

ex:a a ex:Thing ;
    ex:name "A" ;
    ex:link ex:b, ex:c .

ex:S a sh:NodeShape ;
    sh:property [ sh:path ex:name ] ,
        [ sh:path ex:link ] .

ex:a ex:later ex:d .
`;
const EX = 'http://example.org/', SH = 'http://www.w3.org/ns/shacl#';
const at = (target: Parameters<typeof turtlePosition>[2]) => turtlePosition(TEXT, '/tmp/x.ttl', target);

describe('turtlePosition', () => {
    it('a subject: its first statement, not a statement that only refers to it', async () => {
        expect(await at({ subject: EX + 'a' })).toEqual({ line: 6, column: 1 });
    });
    it('a statement: the object of its predicate, in any block of the subject', async () => {
        expect(await at({ subject: EX + 'a', predicate: EX + 'link', object: EX + 'c' })).toEqual({ line: 8, column: 19 });
        expect(await at({ subject: EX + 'a', predicate: EX + 'later', object: EX + 'd' })).toEqual({ line: 14, column: 15 });
        expect(await at({ subject: EX + 'a', predicate: `http://www.w3.org/1999/02/22-rdf-syntax-ns#type`, object: EX + 'Thing' })).toEqual({ line: 6, column: 8 });
    });
    it('a nested node: the [ … ] object that has the predicate and object', async () => {
        expect(await at({ subject: EX + 'S', predicate: SH + 'property', inside: { predicate: SH + 'path', object: EX + 'link' } })).toEqual({ line: 12, column: 9 });
    });
    it('no match: undefined', async () => {
        expect(await at({ subject: EX + 'a', predicate: EX + 'none' })).toBeUndefined();
        expect(await at({ subject: EX + 'missing' })).toBeUndefined();
    });
});
