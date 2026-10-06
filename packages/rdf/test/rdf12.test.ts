import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Quad } from '@rdfjs/types';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRdf, serializeRdf } from '../src/files';
import { ModelStore } from '../src/model-store';
import { skolemize } from '../src/skolem';
import { canonical, parseTrig, writeTrig } from '../src/trig';
import { MODEL_GRAPH } from '../src/graph';
import { docOf } from './helpers';

// RDF 1.2: triple terms, reified triples, annotations (readme → Known problems and limits → RDF 1.2).
const TTL = `@prefix ex: <http://ex/> .
ex:p1 ex:element <<( ex:alice ex:knows ex:bob )>> .
ex:p2 ex:element <<( _:x ex:knows ex:bob )>> .
_:x ex:name "x" .
ex:alice ex:knows ex:carol {| ex:since 2020 |} .
`;

/** No blank nodes; the node with `name` outside a triple term is the same IRI inside it. */
function oneIriInsideAndOutside(quads: Quad[], name: string) {
    expect(quads.some(q => q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode')).toBe(false);
    const node = quads.find(q => q.predicate.value === name)!.subject;
    const inside = quads.map(q => q.object).find((o): o is Quad => o.termType === 'Quad')!;
    expect([inside.subject, inside.object].some(t => t.equals(node))).toBe(true);
}

describe('RDF 1.2 terms', () => {
    it('parses triple terms and annotations', async () => {
        const quads = await parseRdf(TTL, '/tmp/x.ttl');
        expect(quads.filter(q => q.object.termType === 'Quad')).toHaveLength(3);
    });

    it('gives the same canonical form for the same content', async () => {
        const quads = await parseRdf(TTL, '/tmp/x.ttl');
        expect(canonical([...quads].reverse())).toBe(canonical(quads));
    });

    it.each(['/tmp/x.ttl', '/tmp/x.trig', '/tmp/x.nt', '/tmp/x.nq'])('writes and reads back the same dataset (%s)', async file => {
        const quads = await parseRdf(TTL, '/tmp/x.ttl');
        const text = await serializeRdf(quads, file);
        expect(text).toContain('<<(');
        expect(canonical(await parseRdf(text, file))).toBe(canonical(quads));
    });

    it('refuses to write a triple term to JSON-LD', async () => {
        const quads = await parseRdf(TTL, '/tmp/x.ttl');
        await expect(serializeRdf(quads, '/tmp/x.jsonld')).rejects.toThrow(/JSON-LD has no RDF 1.2 triple terms/);
    });

    it('skolemizes a blank node inside a triple term to the same IRI as outside', async () => {
        const { quads } = skolemize(await parseRdf(TTL, '/tmp/x.ttl'));
        const inner = quads.find(q => q.predicate.value === 'http://ex/element' && q.subject.value === 'http://ex/p2')!.object as Quad;
        const outer = quads.find(q => q.predicate.value === 'http://ex/name')!.subject;
        expect(outer.termType).toBe('NamedNode');
        expect(inner.subject.equals(outer)).toBe(true);
    });

    it('writeTrig keeps triple terms and the blank node inside them', async () => {
        const { quads } = await parseTrig(`@prefix ex: <http://ex/> .\n<${MODEL_GRAPH}> {\n${TTL.split('\n').slice(1).join('\n')}}\n`);
        const text = await writeTrig(quads);
        expect(canonical((await parseTrig(text)).quads)).toBe(canonical(quads));
    });
});

const dirs: string[] = [], stores: ModelStore[] = [];
afterEach(async () => {
    for (const store of stores.splice(0)) { await store.idle(); store.close(); }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function workspace(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-rdf12-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'workspace.trig'), '<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> . }\n');
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    const store = new ModelStore();
    store.watching = false;
    stores.push(store);
    expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
    return { store, path: (file: string) => join(dir, file), read: (file: string) => readFileSync(join(dir, file), 'utf8') };
}

describe('RDF 1.2 terms in the store', () => {
    it('keeps statements that differ only in the triple term in their own files', async () => {
        // N-Triples: no text patch (step 5), the file is written from the canonical form.
        const a = '<urn:a> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:Class> .\n<urn:a> <http://www.w3.org/2000/01/rdf-schema#label> "Before" .\n<urn:a> <urn:p> <<( <urn:x> <urn:k> <urn:y> )>> .\n';
        const b = '<urn:a> <urn:p> <<( <urn:x> <urn:k> <urn:z> )>> .\n';
        const w = await workspace({ 'a.nt': a, 'b.nt': b });
        const id = Object.values(docOf(w.store).instances).find(i => i.uri === 'urn:a')!.id;
        expect(w.store.execute({ kind: 'rename', id, label: 'After' }).ok).toBe(true);
        await w.store.idle();
        expect(await w.store.save()).toEqual({ ok: true });
        expect(w.store.dirty).toBe(false);
        const expected = await parseRdf(a.replace('Before', 'After'), w.path('a.nt'));
        expect(canonical(await parseRdf(w.read('a.nt'), w.path('a.nt')))).toBe(canonical(expected));
        expect(w.read('b.nt')).toBe(b);
    });

    it('writes a blank node used inside and outside a triple term as one IRI', async () => {
        const T = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>', L = '<http://www.w3.org/2000/01/rdf-schema#label>';
        const b = `<urn:c> ${T} <urn:Class> .\n<urn:c> ${L} "Before" .\n<urn:p> <urn:e> <<( _:x <urn:k> <urn:b> )>> .\n_:x <urn:name> "x" .\n`;
        const w = await workspace({ 'b.nt': b });
        const id = Object.values(docOf(w.store).instances).find(i => i.uri === 'urn:c')!.id;
        expect(w.store.execute({ kind: 'rename', id, label: 'After' }).ok).toBe(true);
        expect(await w.store.save()).toEqual({ ok: true });
        expect(w.read('b.nt')).toContain('After');
        oneIriInsideAndOutside(await parseRdf(w.read('b.nt'), w.path('b.nt')), 'urn:name');
    });

    it('writes a Turtle file with a blank node in a triple term as IRIs (whole file: the text patch refuses blank nodes)', async () => {
        const a = '@prefix ex: <http://ex/> .\n# comment\nex:a a ex:Class ; <http://www.w3.org/2000/01/rdf-schema#label> "Before" ; ex:p <<( ex:x ex:k _:y )>> .\n_:y ex:name "y" .\n';
        const w = await workspace({ 'a.ttl': a });
        const id = Object.values(docOf(w.store).instances).find(i => i.uri === 'http://ex/a')!.id;
        expect(w.store.execute({ kind: 'rename', id, label: 'After' }).ok).toBe(true);
        expect(await w.store.save()).toEqual({ ok: true });
        expect(w.read('a.ttl')).toContain('After');
        oneIriInsideAndOutside(await parseRdf(w.read('a.ttl'), w.path('a.ttl')), 'http://ex/name');
    });

    it('patches a Turtle file with triple terms: the comment and the triple term text stay', async () => {
        const a = '@prefix ex: <http://ex/> .\n# comment\nex:a a ex:Class ;\n    <http://www.w3.org/2000/01/rdf-schema#label> "Before" ;\n    ex:p <<( ex:x ex:k ex:y )>> .\n';
        const w = await workspace({ 'a.ttl': a });
        const id = Object.values(docOf(w.store).instances).find(i => i.uri === 'http://ex/a')!.id;
        expect(w.store.execute({ kind: 'rename', id, label: 'After' }).ok).toBe(true);
        expect(await w.store.save()).toEqual({ ok: true });
        expect(w.read('a.ttl')).toBe(a.replace('Before', 'After'));
    });

    const T = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>', L = '<http://www.w3.org/2000/01/rdf-schema#label>';
    const annotated = `<urn:a> ${T} <urn:Class> ;\n    ${L} "A" ;\n    <urn:k> <urn:b> {| <urn:since> 2020 |} .\n`;
    const plain = `<urn:c> ${T} <urn:Class> ;\n    ${L} "C" .\n# not an annotation: {| in a comment\n`;
    const rename = (w: Awaited<ReturnType<typeof workspace>>, uri: string, label: string) =>
        w.store.execute({ kind: 'rename', id: Object.values(docOf(w.store).instances).find(i => i.uri === uri)!.id, label }).ok;

    it('reads a file with annotation syntax but does not write it (n3 #677)', async () => {
        const w = await workspace({ 'a.ttl': annotated, 'b.ttl': plain });
        expect(w.store.warnings.filter(x => x.includes('annotation syntax')).map(x => x.slice(0, 5))).toEqual(['a.ttl']);
        expect(rename(w, 'urn:a', 'After')).toBe(true);
        const r = await w.store.save();
        expect(r.ok ? '' : r.error).toContain('a.ttl: has RDF 1.2 annotation syntax');
        expect(w.read('a.ttl')).toBe(annotated);
    });

    it('writes the other files of the workspace', async () => {
        const w = await workspace({ 'a.ttl': annotated, 'b.ttl': plain });
        expect(rename(w, 'urn:c', 'C2')).toBe(true);
        expect(await w.store.save()).toEqual({ ok: true });
        expect(w.read('b.ttl')).toBe(plain.replace('"C"', '"C2"'));
        expect(w.read('a.ttl')).toBe(annotated);
    });
});
