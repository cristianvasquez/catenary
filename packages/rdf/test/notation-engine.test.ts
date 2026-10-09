// The notation engine (ADR 0014) on the example workspace (fixtures/notation): figures, join,
// removal, arrival and data arrival, and the gaps G-C, G-D, G-H. The comparison with the current display: notation-compare.test.ts.

import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Join, NQuad, Notations, Placements, TripleIndex, arrival, join as joinFigures, dataArrival, iri, joinText, nkey, placedTerm, removal, sha256Hex, triple } from '@catenary/model';
import { VALIDATION_GRAPH, type ModelGraph } from '../src/graph';
import { ModelStore } from '../src/model-store';
import { viewFigures } from '@catenary/model';
import { nquads, readNotations, storeIndex } from '../src/notations';
import { skolemize } from '../src/skolem';
import { rdf } from '../src/terms';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/notation/', import.meta.url));
const EX = 'https://example.org/draft/';
const ex = (l: string) => iri(EX + l);
const RDFS_SUB = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const PREFIXES = `@prefix ex: <${EX}> . @prefix sh: <http://www.w3.org/ns/shacl#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix view: <osg://vocab/view#> .
@prefix dct: <http://purl.org/dc/terms/> . @prefix nt: <osg://vocab/notation#> . @prefix shn: <osg://vocab/notation/shapes#> .
@prefix vsn: <osg://vocab/notation/skos#> . @prefix mkn: <osg://vocab/notation/marks#> .\n`;

let dir: string, store: ModelStore, data: TripleIndex, base: NQuad[], notes: Notations;
beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-notation-'));
    cpSync(FIXTURE, dir, { recursive: true });
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
    const graph = (store as unknown as { graph: ModelGraph }).graph;
    data = storeIndex(graph);
    base = nquads(graph.quads().filter(q => q.graph.value !== VALIDATION_GRAPH));
    notes = readNotations();
});
afterAll(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const view = (v: string, d = data) => viewFigures(d, notes, `urn:view:${v}`);
const without = (placed: Placements, ...keys: string[]) => new Map([...placed].filter(([k]) => !keys.includes(k)));
const list = (h: string) => nkey(iri(`urn:trellis:list:${h}`));
/** The figures and the join of the shapes view with extra Turtle (scratch data of the "Verified" checks). */
async function withTurtle(ttl: string, v = 'shapes') {
    const extra = nquads(skolemize([...await rdf.io.dataset.fromText('text/turtle', PREFIXES + ttl)]).quads);
    return view(v, new TripleIndex([...base, ...extra] as NQuad[]));
}
const rowsOf = (j: Join, title: string) => j.boxes.find(b => b.figure.title === title)?.rows.map(r => r.text);

describe('sha256Hex', () => {
    it('is SHA-256 of the UTF-8 text', () => {
        for (const s of ['', 'abc', 'é ✓ 𝄞', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(200)])
            expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    });
});

describe('figures and join of the example views', () => {
    // Same content as the output of the draft derivation (figures/*.join.txt of commit e30c742), except: values sorted by IRI (the store has no file
    // order), and the texts of the app (decision of 2026-10-06): a tag without a label reads «Kind», not «gufo:Kind»; an instance
    // field without sh:name reads birthDate, not ex:birthDate.
    for (const v of ['model', 'shapes', 'people']) it(`of the ${v} view`, () => {
        const { derivation, join: j } = view(v);
        expect(joinText(derivation, j).join('\n') + '\n').toBe(readFileSync(FIXTURE + `expected/${v}.join.txt`, 'utf8'));
    });
    it('place the 5 list figures of the views by rule 12', () => {
        const placedLists = ['model', 'shapes'].flatMap(v => {
            const { derivation, placed } = view(v);
            return derivation.figures.filter(f => f.placedAs !== f.focus && placed.has(nkey(f.placedAs))).map(f => f.placedAs.value);
        });
        expect(placedLists).toHaveLength(5);
        expect(placedLists).toEqual(expect.arrayContaining(['0f1d7b1cb919', '1c24175aa2b9', '8c7eb551ddb4', 'ed292fa4d715'].map(h => `urn:trellis:list:${h}`)));
    });
});

describe('removal (rule 6)', () => {
    it('of the xone hub takes only the hub placement (edits/remove-hub-member.trig)', () => {
        const { derivation, placed } = view('shapes');
        expect(removal(derivation.figures, placed, iri('urn:trellis:list:8c7eb551ddb4'))).toEqual([list('8c7eb551ddb4')]);
    });
    it('of a line takes its "in" box (kept by lines)', () => {
        const { derivation, placed } = view('shapes');
        expect(removal(derivation.figures, placed, ex('Marriage-kind')).sort()).toEqual([nkey(ex('Marriage-kind')), list('ed292fa4d715')].sort());
    });
    it('of a line keeps a box that the user placed, and takes a box with view:keptByLines', async () => {
        const { derivation, placed } = view('shapes');
        expect(removal(derivation.figures, placed, ex('Person-nationality'))).toEqual([nkey(ex('Person-nationality'))]);
        const kept = new Map(placed);
        kept.set(nkey(ex('Countries')), { ...placed.get(nkey(ex('Countries')))!, keptByLines: true });
        expect(removal(derivation.figures, kept, ex('Person-nationality')).sort()).toEqual([nkey(ex('Person-nationality')), nkey(ex('Countries'))].sort());
    });
    it('of a box takes its hub and its links', () => {
        const { derivation, placed } = view('model');
        expect(removal(derivation.figures, placed, ex('Woman')).sort()).toEqual([
            nkey(ex('Woman')), list('1c24175aa2b9'), nkey(triple(ex('Wife'), RDFS_SUB, ex('Woman')))
        ].sort());
    });
});

describe('arrival (rule 11)', () => {
    it('of a node shape brings its hub and its lines', () => {
        const { derivation, placed } = view('shapes');
        const before = without(placed, nkey(ex('Person')), list('8c7eb551ddb4'), nkey(ex('Person-nationality')));
        expect(arrival(derivation.figures, before, placedTerm(derivation.figures, ex('Person'))).sort())
            .toEqual([nkey(ex('Person')), list('8c7eb551ddb4'), nkey(ex('Person-nationality'))].sort());
    });
    it('of a class brings its generalization set and a link, but not a statement that the hub covers', () => {
        const { derivation, placed } = view('model');
        const sub = nkey(triple(ex('Wife'), RDFS_SUB, ex('Woman')));
        const before = without(placed, nkey(ex('Woman')), list('1c24175aa2b9'), sub);
        expect(arrival(derivation.figures, before, ex('Woman')).sort()).toEqual([nkey(ex('Woman')), list('1c24175aa2b9'), sub].sort());
    });
    it('of an instance brings its 2 links', () => {
        const { derivation, placed } = view('people');
        const links = [nkey(triple(ex('john'), EX + 'marriedTo', ex('mary'))), nkey(triple(ex('m1'), EX + 'wife', ex('mary')))];
        expect(arrival(derivation.figures, without(placed, nkey(ex('mary')), ...links), ex('mary')).sort()).toEqual([nkey(ex('mary')), ...links].sort());
    });
});

describe('data arrival (rule 11b, G-F)', () => {
    it('places a new statement or line whose ends are shown, and not a line with a private end', () => {
        const { derivation, placed } = view('people');
        const link = nkey(triple(ex('john'), EX + 'marriedTo', ex('mary')));
        expect(dataArrival(derivation.figures, without(placed, link), new Set([link]))).toEqual([link]);
        const shapes = view('shapes');
        const lines = [ex('Person-nationality'), ex('Person-name')].map(nkey);
        expect(dataArrival(shapes.derivation.figures, without(shapes.placed, lines[0]), new Set(lines))).toEqual([lines[0]]);
    });
});

describe('rows', () => {
    it('show a list box inline while its line is not placed', () => {
        const { derivation, placed } = view('shapes');
        const rows = rowsOf(joinFigures(derivation, without(placed, nkey(ex('Marriage-date')), nkey(ex('Marriage-kind')))), 'Marriage');
        expect(rows).toContain('ex:date: xsd:date | xsd:gYear [0..1]');
        expect(rows).toContain('ex:kind: {Civil, Religious} [1]');
    });
    it('G-H: a complex path reads as path text', async () => {
        const { join: j } = await withTurtle(`ex:Person sh:property ex:Person-parentName .
            ex:Person-parentName sh:path ( [ sh:inversePath ex:child ] ex:name ) ; sh:datatype xsd:string .`);
        expect(rowsOf(j, 'Person')).toContain('^ex:child/ex:name: xsd:string [0..*]');
    });
    it('G-D: a property shape under sh:not is a row with the tag «not»', async () => {
        const { join: j } = await withTurtle(`ex:Person sh:not ex:Person-noAlias . ex:Person-noAlias sh:path ex:alias ; sh:minCount 1 .`);
        expect(rowsOf(j, 'Person')).toContain('«not» ex:alias: any [1..*]');
    });
});

describe('helper shapes (G-C)', () => {
    it('a scheme helper with sh:in, sh:minCount and two schemes has no card; the line ends at the first scheme', async () => {
        const r = await withTurtle(`ex:Marriage sh:property ex:Marriage-place . ex:Marriage-place sh:path ex:place ; sh:node ex:InPlaces .
            ex:InPlaces a sh:NodeShape ; rdfs:label "in places" ; sh:property [ sh:path skos:inScheme ; sh:minCount 1 ; sh:in ( ex:Countries ex:MarriageKinds ) ] .
            <urn:view:shapes/p/Marriage-place> a view:Placement ; view:view <urn:view:shapes> ; view:element ex:Marriage-place .`);
        expect(r.derivation.figures.find(f => f.focus.value === EX + 'InPlaces')?.fs.node.value).not.toBe('osg://vocab/notation/shapes#Card');
        expect(r.join.lines.map(l => `${l.start.title} → ${l.end?.title}`)).toContain('Marriage → Countries');
    });
    it('a collection helper (dct:source, sh:in) has no card; the line ends at the collection', async () => {
        const r = await withTurtle(`ex:Lowlands a skos:Collection ; skos:prefLabel "Lowlands" ; skos:member ex:nl , ex:be .
            ex:Person sh:property ex:Person-home . ex:Person-home sh:path ex:home ; sh:node ex:InLowlands .
            ex:InLowlands a sh:NodeShape ; dct:source ex:Lowlands ; sh:in ( ex:nl ex:be ) .`);
        expect(r.derivation.figures.find(f => f.focus.value === EX + 'InLowlands')?.fs.node.value).not.toBe('osg://vocab/notation/shapes#Card');
        expect(rowsOf(r.join, 'Person')).toContain('ex:home: Lowlands [0..*]');
    });
});

