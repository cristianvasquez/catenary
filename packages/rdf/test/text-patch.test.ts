import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Quad } from '@rdfjs/types';
import { parseRdf } from '../src/files';
import { forgetTurtleTrees, patchTurtle } from 'rdf-files';
import { rdf } from '../src/terms';
import { canonical } from '../src/trig';
import { fileURLToPath } from 'node:url';

const EX = 'http://example.org/', RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', XSD = 'http://www.w3.org/2001/XMLSchema#';
const FILE = '/tmp/x.ttl';
const n = (l: string) => rdf.namedNode(l.includes(':') ? l : EX + l);
const int = (v: number) => rdf.literal(String(v), n(XSD + 'integer'));
const t = (s: string, p: string, o: string | Quad['object']) => rdf.quad(n(s), n(p), typeof o === 'string' ? n(o) : o);

/** The triples of a text (an annotation keeps its blank reifier: the canonical form compares it). */
async function read(text: string, file = FILE) {
    return (await parseRdf(text, file)).map(q => rdf.quad(q.subject, q.predicate, q.object));
}

/** Patch from the read of `text` to `edit(read)`; check that the new text reads as that. Returns the new text. */
async function patch(text: string, edit: (quads: Quad[]) => Quad[], file = FILE, prefixes: Record<string, string> = {}): Promise<string> {
    const before = await read(text, file);
    const after = edit(before);
    const r = await patchTurtle(text, file, before, after, prefixes);
    if (!r.ok) throw new Error(r.reason);
    expect(canonical(await read(r.text, file))).toBe(canonical(after));
    return r.text;
}
const without = (...qs: Quad[]) => (quads: Quad[]) => quads.filter(q => !qs.some(x => x.equals(q)));
const plus = (...qs: Quad[]) => (quads: Quad[]) => [...quads, ...qs];

const HAND = `# Library data, written by hand
@prefix ex: <http://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

# The main library
ex:lib a ex:Library ;          # type
    rdfs:label "City library"@en , "Stadtbibliothek"@de ;
    ex:holds ex:b1 , ex:b2 ;
    ex:address ex:lib-address .

ex:b1 a ex:Book .

# more about the library, later in the file
ex:lib ex:opened 1990 .
`;

describe('text patch: simple triples', () => {
    it('removes one object; comments and the other statements stay byte for byte', async () => {
        expect(await patch(HAND, without(t('lib', 'holds', 'b2')))).toBe(HAND.replace('ex:holds ex:b1 , ex:b2 ;', 'ex:holds ex:b1 ;'));
    });

    it('removes a whole property with its separator; the last property with the separator before it', async () => {
        expect(await patch(HAND, without(t('lib', 'holds', 'b1'), t('lib', 'holds', 'b2')))).toBe(HAND.replace('    ex:holds ex:b1 , ex:b2 ;\n', ''));
        const text = '@prefix ex: <http://example.org/> .\nex:a ex:p 1 ;\n  ex:q 2 .\n';
        expect(await patch(text, without(t('a', 'q', int(2))))).toBe('@prefix ex: <http://example.org/> .\nex:a ex:p 1 .\n');
    });

    it('adds an object to an existing predicate and a new property, with the prefixes and indentation of the file', async () => {
        const out = await patch(HAND, plus(t('b1', RDF + 'type', 'Novel'), t('b1', 'http://www.w3.org/2000/01/rdf-schema#label', rdf.literal('Dune'))));
        expect(out).toBe(HAND.replace('ex:b1 a ex:Book .', 'ex:b1 a ex:Book, ex:Novel ;\n    rdfs:label "Dune" .'));
    });

    it('a subject in two blocks: a removal applies where the triple is, an addition goes to the first block', async () => {
        const out = await patch(HAND, q => [...without(t('lib', 'opened', int(1990)))(q), t('lib', 'closed', int(2020))]);
        expect(out).toBe(HAND.replace('ex:address ex:lib-address .', 'ex:address ex:lib-address ;\n    ex:closed 2020 .').replace('ex:lib ex:opened 1990 .\n', ''));
    });

    it('a new subject is a new block at the end', async () => {
        const out = await patch(HAND, plus(t('b3', RDF + 'type', 'Book'), t('b3', 'holds', 'b1')));
        expect(out).toBe(HAND + '\nex:b3 a ex:Book ;\n    ex:holds ex:b1 .\n');
    });

    it('adding a triple that is in the file changes nothing; a removal that is not in the file is refused', async () => {
        expect(await patch(HAND, plus(t('lib', 'holds', 'b1')))).toBe(HAND);
        const before = await read(HAND);
        const r = await patchTurtle(HAND, FILE, [...before, t('lib', 'holds', 'b9')], before);
        expect(r).toEqual({ ok: false, reason: expect.stringContaining('not in the text') });
    });
});

describe('text patch: prefixes of the caller', () => {
    const FOAF = 'http://xmlns.com/foaf/0.1/';
    const person = plus(t('p1', RDF + 'type', FOAF + 'Person'), t('p1', FOAF + 'name', rdf.literal('Ann')));

    it('a namespace that the file does not declare: the prefix of the caller, its directive after the last one of the file', async () => {
        const out = await patch(HAND, person, FILE, { foaf: FOAF, rdfs: 'urn:not-used:' });
        const directives = '@prefix ex: <http://example.org/> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n';
        expect(out).toBe(HAND.replace(directives, directives + `@prefix foaf: <${FOAF}> .\n`) + '\nex:p1 a foaf:Person ;\n    foaf:name "Ann" .\n');
    });

    it('the prefixes of the file win; a name that the file declares for another namespace is not used', async () => {
        const text = `@prefix f: <${FOAF}>.\n@prefix ex: <http://example.org/>.\n\nex:a ex:p 1.\n`;
        expect(await patch(text, person, FILE, { foaf: FOAF })).toBe(text + '\nex:p1 a f:Person ;\n    f:name "Ann".\n');
        const other = '@prefix foaf: <urn:other:> .\n@prefix ex: <http://example.org/> .\nex:a ex:p 1 .\n';
        expect(await patch(other, person, FILE, { foaf: FOAF })).toBe(other + `\nex:p1 a <${FOAF}Person> ;\n    <${FOAF}name> "Ann" .\n`);
    });

    it('the directive form of the file (PREFIX); a file without directives gets them before its first statement', async () => {
        const sparql = 'PREFIX ex: <http://example.org/>\nex:a ex:p 1 .\n';
        expect(await patch(sparql, person, FILE, { foaf: FOAF, ex: 'http://example.org/' }))
            .toBe(`PREFIX ex: <http://example.org/>\nPREFIX foaf: <${FOAF}>\nex:a ex:p 1 .\n\nex:p1 a foaf:Person ;\n    foaf:name "Ann" .\n`);
        const bare = '# comment\n<http://example.org/a> <http://example.org/p> 1 .\n';
        expect(await patch(bare, person, FILE, { foaf: FOAF, ex: 'http://example.org/' }))
            .toBe(`# comment\n@prefix ex: <http://example.org/> .\n@prefix foaf: <${FOAF}> .\n\n<http://example.org/a> <http://example.org/p> 1 .\n\nex:p1 a foaf:Person ;\n    foaf:name "Ann" .\n`);
        expect(await patch('', person, FILE, { foaf: FOAF, ex: 'http://example.org/' }))
            .toBe(`@prefix ex: <http://example.org/> .\n@prefix foaf: <${FOAF}> .\n\nex:p1 a foaf:Person ;\n    foaf:name "Ann" .\n`);
    });
});

it('a text with a blank node is not patched (Catenary has no blank nodes; the caller writes the whole file)', async () => {
    for (const text of ['@prefix ex: <urn:ex:> .\nex:a ex:p [ ex:q 1 ] .\n', '@prefix ex: <urn:ex:> .\nex:a ex:p ( 1 ) .\n', '@prefix ex: <urn:ex:> .\n_:b ex:p 1 .\n', '@prefix ex: <urn:ex:> .\n[] ex:p 1 .\n']) {
        const before = await read(text);
        expect(await patchTurtle(text, FILE, before, [])).toEqual({ ok: false, reason: expect.stringContaining('blank node') });
    }
});

// Every triple of the fixtures: remove it, and add it back. Each step reads as expected. A fixture with blank nodes is not patched.
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
// Turtle files only: view files are TriG (*.view.trig) and a save writes them as a whole.
const files = readdirSync(FIXTURES).filter(f => f.endsWith('.ttl')).map(f => FIXTURES + f);
// Every triple of each fixture file: about 1000 parses for shapes.ttl. It can exceed the default timeout of 5 s on a busy machine.
describe('text patch: every triple of the fixtures', () => {
    for (const file of files) {
        it(`remove and add back each triple of ${file.slice(FIXTURES.length)}`, async () => {
            const text = readFileSync(file, 'utf8');
            const before = await read(text, file);
            if (before.some(q => q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode')) {
                expect((await patchTurtle(text, file, before, before.slice(1))).ok).toBe(false);
                return;
            }
            const stats = { done: 0, refused: new Map<string, number>(), lines: [] as number[] };
            for (const q of before) {
                const after = without(q)(before);
                const r = await patchTurtle(text, file, before, after);
                if (!r.ok) {
                    const k = r.reason.replace(/ .*/, '');
                    stats.refused.set(k, (stats.refused.get(k) ?? 0) + 1);
                    continue;
                }
                const again = await read(r.text, file);
                expect(canonical(again), `remove ${q.subject.value} ${q.predicate.value} ${q.object.value}`).toBe(canonical(after));
                stats.done++;
                const oldLines = new Set(text.split('\n'));
                stats.lines.push(r.text.split('\n').filter(l => !oldLines.has(l)).length);
                const back = await patchTurtle(r.text, file, again, [...again, q]);
                if (!back.ok) throw new Error(`add back ${q.subject.value} ${q.predicate.value}: ${back.reason}`);
                expect(canonical(await read(back.text, file))).toBe(canonical(before));
            }
            const sorted = stats.lines.sort((a, b) => a - b);
            console.log(`${file.slice(FIXTURES.length)}: ${stats.done}/${before.length} patched, refused ${JSON.stringify([...stats.refused])}, new lines per patch: median ${sorted[sorted.length >> 1] ?? 0}, max ${sorted[sorted.length - 1] ?? 0}`);
            expect(stats.done).toBe(before.length);
        }, 30_000);
    }
});

it.each([
    '<urn:s> <urn:p> "old" .\n@prefix ex: <urn:> .\n',
    '@prefix ex: <urn:> .\nex:s ex:p "old" .\n@prefix ex: <urn:other:> .\n'
])('writes prefixes at the insertion offset: %s', async text => {
    await patch(text, qs => [...qs, rdf.quad(rdf.namedNode('urn:s'), rdf.namedNode('urn:other:added'), rdf.namedNode('urn:value'))]);
});

describe('text patch: RDF 1.2', () => {
    const TEXT = `@prefix ex: <${EX}> .
# placements
ex:pl a ex:Placement ;
    ex:reifies <<( ex:a ex:knows ex:b )>> ;
    ex:x 1 .
ex:a ex:age 30 ;
    ex:knows ex:c {| ex:since 2020 |} .
`;
    // Not `ex:knows ex:c {| … |} ; ex:age 30`: n3 2.7.12 drops the statements after an annotation followed by `;` or `,`.
    async function patch(edit: (qs: Quad[]) => Quad[]) {
        const before = await read(TEXT);
        const after = edit(before);
        const r = await patchTurtle(TEXT, FILE, before, after);
        if (!r.ok) throw new Error(r.reason);
        expect(canonical(await read(r.text))).toBe(canonical(after));
        return r.text;
    }
    const isP = (q: Quad, p: string) => q.predicate.value === EX + p;

    it('an edit next to a triple term keeps the triple term text byte for byte', async () => {
        const text = await patch(qs => qs.map(q => isP(q, 'x') ? t('pl', 'x', int(2)) : q));
        expect(text).toBe(TEXT.replace('ex:x 1', 'ex:x 2'));
    });

    it('changes the object of a triple term', async () => {
        const text = await patch(qs => qs.map(q => isP(q, 'reifies') ? t('pl', 'reifies', rdf.quad(n('a'), n('knows'), n('d'))) : q));
        expect(text).toBe(TEXT.replace('<<( ex:a ex:knows ex:b )>>', '<<( ex:a ex:knows ex:d )>>'));
    });

    it('keeps an annotation when another property of its subject changes', async () => {
        const text = await patch(qs => qs.map(q => isP(q, 'age') ? t('a', 'age', int(31)) : q));
        expect(text).toBe(TEXT.replace('ex:age 30', 'ex:age 31'));
    });

    it('refuses to remove an annotated object (the caller writes the whole file)', async () => {
        const before = await read(TEXT);
        const after = before.filter(q => !(isP(q, 'knows') && q.object.value === EX + 'c'));
        expect((await patchTurtle(TEXT, FILE, before, after)).ok).toBe(false);
    });
});


describe('kept syntax trees (incremental parse)', () => {
    it('a sequence of patches gives the same texts with the kept tree as with a new parse of each text', async () => {
        const steps: ((qs: Quad[]) => Quad[])[] = [
            plus(t('lib', 'opens', int(9))),
            without(t('lib', 'holds', 'b1')),
            plus(t('newThing', RDF + 'type', 'Library'), t('newThing', 'holds', 'b1')),
            qs => qs.map(q => q.object.equals(int(9)) ? t('lib', 'opens', int(10)) : q),
            plus(t('lib', 'holds', 'b3'), t('b3', RDF + 'type', 'Book')),
            without(t('newThing', RDF + 'type', 'Library'), t('newThing', 'holds', 'b1')),
            plus(t('lib', 'note', rdf.literal('line one\nline two é'))),
            qs => qs.filter(q => !q.predicate.equals(n('note')))
        ];
        const run = async (fresh: boolean) => {
            forgetTurtleTrees();
            const texts: string[] = [];
            let text = HAND;
            for (const step of steps) {
                if (fresh) forgetTurtleTrees();
                text = await patch(text, step, '/tmp/kept.ttl');
                texts.push(text);
            }
            return texts;
        };
        const kept = await run(false), fresh = await run(true);
        expect(kept).toEqual(fresh);
    });
});
