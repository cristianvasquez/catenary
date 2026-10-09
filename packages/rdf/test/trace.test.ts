import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKey, type TraceSpan } from '@catenary/model';
import { OxigraphStore, parseRdfSync } from 'rdf-files';
import { ModelGraph } from '../src/graph';
import { shapeTargetMatches } from '../src/shacl-targets';
import { ModelStore } from '../src/model-store';
import { TracedStore, Tracer, tracer } from '../src/trace';
import { rdf } from '../src/terms';
import { emptyMetamodel } from '../src/shapes';
import * as validation from '../src/validate';
import { ValidationRunner } from '../src/validation-runner';
import { DATA, SHAPES, emptyGraph, writeWorkspace } from './helpers';

const dirs: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    while (tracer.on) tracer.setClient(false);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const byId = (spans: TraceSpan[]) => new Map(spans.map(s => [s.id, s]));
/** The kinds and names from `s` up to its first span. */
const causes = (spans: TraceSpan[], s: TraceSpan): string[] => {
    const all = byId(spans), out: string[] = [];
    for (let p = s.parent === undefined ? undefined : all.get(s.parent); p; p = p.parent === undefined ? undefined : all.get(p.parent)) out.push(`${p.kind}:${p.name}`);
    return out;
};

describe('tracer', () => {
    it('records nothing while no client reads, and clears all data when the last client stops', () => {
        const t = new Tracer();
        expect(t.span('rpc', 'a', () => 1)).toBe(1);
        t.event('validation', 'scheduled');
        expect(t.take()).toMatchObject({ spans: [], stats: [], on: false });
        t.setClient(true);
        t.setClient(true);
        t.span('rpc', 'a', () => 1);
        t.setClient(false);
        expect(t.take().spans).toHaveLength(1);
        t.setClient(false);
        expect(t.take()).toMatchObject({ spans: [], stats: [], on: false });
    });

    it('a span that starts inside another, also after an await, is its child; queries add to the span and its ancestors', async () => {
        const t = new Tracer();
        t.setClient(true);
        await t.span('rpc', 'outer', async () => {
            await Promise.resolve();
            t.span('refresh', 'inner', () => t.match('m', () => []));
            t.sparql('select', 'SELECT * { <urn:a> ?p "x" } LIMIT 5', () => []);
        });
        const { spans, stats } = t.take();
        const outer = spans.find(s => s.name === 'outer')!, inner = spans.find(s => s.name === 'inner')!;
        const query = spans.find(s => s.kind === 'sparql')!;
        expect(inner.parent).toBe(outer.id);
        expect(query.parent).toBe(outer.id);
        expect(query.name).toBe('select: SELECT * { <…> ?p "…" } LIMIT N');
        expect([outer.queries, inner.queries]).toEqual([2, 1]);
        expect(stats.find(s => s.kind === 'match')).toMatchObject({ name: 'm', calls: 1 });
    });

    it('a span that ends after the recording stopped or was cleared is not recorded', async () => {
        const t = new Tracer();
        t.setClient(true);
        let finish!: () => void;
        const running = t.span('validation', 'run', () => new Promise<void>(r => { finish = r; }));
        t.setClient(false);
        t.setClient(true);
        finish();
        await running;
        let again!: () => void;
        const cleared = t.span('validation', 'run', () => new Promise<void>(r => { again = r; }));
        t.clear();
        again();
        await cleared;
        t.span('rpc', 'after', () => 0);
        expect(t.take().spans.map(s => s.name)).toEqual(['after']);
        expect(t.take().stats.map(s => s.name)).toEqual(['after']);
    });

    it('a failed span is marked and the error passes through', async () => {
        const t = new Tracer();
        t.setClient(true);
        expect(() => t.span('rpc', 'sync', () => { throw new Error('x'); })).toThrow('x');
        await expect(t.span('rpc', 'async', () => Promise.reject(new Error('y')))).rejects.toThrow('y');
        expect(t.take().spans.map(s => [s.name, s.error])).toEqual([['sync', true], ['async', true]]);
    });

    it('gives the spans after `since` and counts the spans that the buffer dropped', () => {
        const t = new Tracer();
        t.setClient(true);
        t.span('rpc', 'first', () => 0);
        const { seq } = t.take();
        for (let i = 0; i < 4000; i++) t.span('rpc', 'many', () => 0);
        const batch = t.take(seq);
        expect(batch.spans.length + batch.dropped).toBe(4000);
        expect(batch.dropped).toBeGreaterThan(0);
        expect(batch.stats.find(s => s.name === 'many')?.calls).toBe(4000);
        expect(t.take(batch.seq).spans).toEqual([]);
    });

    it('queryKey: one key for the same query about other elements', () => {
        const a = 'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\nSELECT ?l { <urn:x:1> rdfs:label ?l FILTER(?l != "a") }';
        const b = 'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\nSELECT ?l { <urn:x:2> rdfs:label ?l FILTER(?l != "b") }';
        expect(queryKey(a)).toBe(queryKey(b));
        expect(queryKey(a)).toBe('SELECT ?l { <…> rdfs:label ?l FILTER(?l != "…") }');
    });
});

describe('traced store', () => {
    it('attributes the SHACL walk and uncached reference reads to their caller', () => {
        const quads = parseRdfSync('<urn:name:model> { <urn:S> <http://www.w3.org/ns/shacl#targetNode> <urn:a> . }', 'application/trig');
        const graph = new ModelGraph(new TracedStore(new OxigraphStore(quads)));
        tracer.setClient(true);
        for (let i = 0; i < 2; i++) expect(shapeTargetMatches(graph, { nodes: [{ termType: 'NamedNode', value: 'urn:a' }] })).toHaveLength(1);
        const { spans } = tracer.take();
        const matches = spans.filter(s => s.kind === 'shacl' && s.name === 'target matches');
        expect(matches).toHaveLength(2);
        expect(matches[0].detail).toContain('references uncacheable;');
        expect(spans.filter(s => s.name === 'read node references')).toHaveLength(2);
        expect(causes(spans, spans.find(s => s.name === 'walk')!)).toEqual(['shacl:target matches']);
    });

    it('reports select, construct and match, and passes the results through', () => {
        const inner = new OxigraphStore([rdf.quad(rdf.namedNode('urn:s'), rdf.namedNode('http://ex.org/p'), rdf.literal('o'))]);
        const store = new TracedStore(inner);
        tracer.setClient(true);
        expect(store.select('SELECT ?s { ?s ?p ?o }')).toHaveLength(1);
        expect(store.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }')).toHaveLength(1);
        expect(store.match(null, rdf.namedNode('http://ex.org/p'))).toHaveLength(1);
        const { spans, stats } = tracer.take();
        expect(spans.map(s => [s.name, s.size])).toEqual([['select: SELECT ?s { ?s ?p ?o }', 1], ['construct: CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 1]]);
        expect(stats.find(s => s.kind === 'match')).toMatchObject({ name: 'match(? p ? ?)', calls: 1, size: 1 });
    });

    it('an edit gives a command span with the change, its listeners and the file write below it', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'catenary-trace-'));
        dirs.push(dir);
        writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
        writeFileSync(join(dir, 'data.ttl'), DATA);
        const store = new ModelStore();
        store.watching = false;
        expect((await store.open(writeWorkspace(dir))).ok).toBe(true);
        store.onDidChange(() => tracer.span('refresh', 'listener', () => store.viewLabels()));
        tracer.setClient(true);
        expect(store.execute({ kind: 'createView', label: 'Traced' }).ok).toBe(true);
        await store.idle();
        const { spans } = tracer.take();
        const command = spans.find(s => s.kind === 'command' && s.name === 'createView')!;
        expect(command.queries).toBeGreaterThan(0);
        const listener = spans.find(s => s.name === 'listener')!;
        expect(causes(spans, listener)).toEqual(['change:edit', 'command:createView']);
        expect(spans.find(s => s.kind === 'change' && s.name === 'edit')?.detail).toMatch(/^1 listeners; views 1/);
        expect(causes(spans, spans.find(s => s.kind === 'file' && s.name === 'write')!)).toContain('command:createView');
        store.close();
    });

    it('validation: each change schedules a run; a run says what it validated, and a stale run says that it was discarded', async () => {
        let finish!: (v: { violations: []; report: [] }) => void;
        vi.spyOn(validation, 'validateWithReport')
            .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
            .mockResolvedValueOnce({ violations: [], report: [] });
        const pending: (() => void)[] = [];
        const r = new ValidationRunner(() => ({ graph: emptyGraph(), metamodel: emptyMetamodel() }), () => undefined,
            { set: fn => pending.push(fn), clear: () => undefined });
        tracer.setClient(true);
        r.invalidate();
        r.invalidate();
        const stale = r.now();
        await r.now();
        finish({ violations: [], report: [] });
        await stale;
        const spans = tracer.take().spans.filter(s => s.kind === 'validation');
        expect(spans.map(s => [s.name, s.detail])).toEqual([
            ['scheduled', 'run 1 in 250 ms'],
            ['scheduled', 'run 2 in 250 ms'],
            ['run', 'run 4: 0 violations, unchanged'],
            ['discarded', 'run 3'],
            ['run', 'run 3: discarded, a newer change came']
        ]);
        expect(pending).toHaveLength(2);
    });
});
