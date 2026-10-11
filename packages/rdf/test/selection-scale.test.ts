// The panel reads of a few hundred selected placements (spec/manifest.hs §11.3 readBudgetMs): a bounded number of store reads
// (SPARQL queries and pattern matches), not one or more per selected id. The tracer counts the SPARQL queries of the store as spans
// and all store reads in the `queries` of the enclosing span (report-read.test.ts pattern).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NS, iriId } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { tracer } from '../src/trace';
import { WORKSPACE } from './helpers';

const N = 300, EDGES = 10;
const THING = 'urn:x:Thing', LOOSE = 'urn:x:Loose', KNOWS = 'urn:x:knows', VIEW = 'urn:name:Big';
const instance = (i: number) => `urn:x:i${String(i).padStart(4, '0')}`;
const placement = (i: number) => `${VIEW}/p/${String(i).padStart(4, '0')}`;
const edge = (i: number) => `${VIEW}/e/${String(i).padStart(4, '0')}`;

const SHAPES = `@prefix sh: <${NS.sh}> .
<urn:x:ThingShape> a sh:NodeShape ; sh:targetClass <${THING}> ; sh:name "Thing" ;
  sh:property [ sh:path <${NS.rdfs}label> ; sh:datatype <http://www.w3.org/2001/XMLSchema#string> ] ;
  sh:property [ sh:path <${KNOWS}> ; sh:class <${THING}> ] .
`;
// Even instances: Thing (a node shape targets it). Odd instances: Loose (no node shape). Each instance knows the next one.
const DATA = [...Array(N).keys()].map(i => `<${instance(i)}> a <${i % 2 ? LOOSE : THING}> ; <${NS.rdfs}label> "Item ${i}" ${i + 1 < N ? `; <${KNOWS}> <${instance(i + 1)}>` : ''} .`).join('\n');
// A card per instance, and an edge for the first EDGES relations: the other relations are hidden.
const VIEW_FILE = `<${VIEW}> {
  <${VIEW}> a <${NS.view}View> ; <${NS.rdfs}label> "Big" .
${[...Array(N).keys()].map(i => `  <${placement(i)}> a <${NS.view}Placement> ; <${NS.view}element> <${instance(i)}> ; <${NS.view}x> ${(i % 20) * 200} ; <${NS.view}y> ${Math.floor(i / 20) * 100} ; <${NS.view}view> <${VIEW}> .`).join('\n')}
${[...Array(EDGES).keys()].map(i => `  <${edge(i)}> a <${NS.view}Placement> ; <${NS.rdf}reifies> <<( <${instance(i)}> <${KNOWS}> <${instance(i + 1)}> )>> ; <${NS.view}view> <${VIEW}> .`).join('\n')}
}
`;

let dir: string, store: ModelStore;
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-selection-scale-'));
    writeFileSync(join(dir, 'workspace.trig'), WORKSPACE);
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    mkdirSync(join(dir, 'views'));
    writeFileSync(join(dir, 'views', 'big.view.trig'), VIEW_FILE);
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
});
afterEach(async () => {
    while (tracer.on) tracer.setClient(false);
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

/** A read under the tracer: its answer, its SPARQL queries, all its store reads (queries and matches) and its time. */
function measure<T>(name: string, read: () => T): { answer: T; sparql: number; reads: number; ms: number } {
    tracer.setClient(true);
    const t0 = performance.now();
    const answer = tracer.span('rpc', name, read);
    const ms = performance.now() - t0;
    const batch = tracer.take();
    tracer.setClient(false);
    const span = batch.spans.find(s => s.kind === 'rpc' && s.name === name)!;
    return { answer, sparql: batch.spans.filter(s => s.kind === 'sparql').length, reads: span.queries ?? 0, ms };
}

const view = iriId(VIEW), ids = [...Array(N).keys()].map(i => iriId(placement(i))), elements = [...Array(N).keys()].map(i => iriId(instance(i)));
const relation = (i: number) => `r-${iriId(instance(i)).slice(2)}-${iriId(KNOWS).slice(2)}-${iriId(instance(i + 1)).slice(2)}`;
/**
 * The store reads that a scoped read of n instances still makes once per instance: the file of each instance (model-store.ts
 * `decorate`, placement.ts filesOfSubject; spec/open.md PERF7). Every other read of these tests is bounded.
 */
const PER_INSTANCE = N;

describe('selection reads of a few hundred placements (§11.3 law readBudgetMs)', () => {
    it('selectionActions: the facts of each item with a bounded number of store reads, not two or more per id', { timeout: 10_000 }, () => {
        store.reads.selectionActions({ view, ids: ids.slice(0, 2), activeView: view });
        const { answer, sparql, reads } = measure('selectionActions', () => store.reads.selectionActions({ view, ids, activeView: view }));
        expect(sparql).toBeLessThanOrEqual(25);
        expect(reads).toBeLessThanOrEqual(PER_INSTANCE + 100);
        expect(answer.items).toHaveLength(N);
        expect(answer.actions.map(a => a.id)).toEqual(['catenary.proposeShapes', 'catenary.collect', 'catenary.removeFromView', 'catenary.deleteFromModel']);
        for (const [i, item] of answer.items.entries()) {
            expect(item).toMatchObject({
                id: ids[i], element: iriId(instance(i)), kinds: ['instance'], types: [i % 2 ? LOOSE : THING], placed: true, placedInActive: true, views: 1, files: 1,
                unshaped: i % 2 ? [LOOSE] : []
            });
        }
        expect(answer.cards).toHaveLength(N);
    });

    it('selectionActions again: the files, placements and shaped classes come from the request context, not from the store', () => {
        const first = measure('selectionActions', () => store.reads.selectionActions({ view, ids, activeView: view }));
        const again = measure('selectionActions', () => store.reads.selectionActions({ view, ids, activeView: view }));
        expect(again.sparql).toBeLessThan(first.sparql);
        expect(again.sparql).toBeLessThanOrEqual(25);
        expect(again.answer).toEqual(first.answer);
    });

    it('selected: each placement resolved to its instance with a bounded number of queries', () => {
        const { answer, sparql } = measure('selected', () => store.reads.selected({ view, ids }));
        expect(sparql).toBeLessThanOrEqual(4);
        expect(answer.view).toBe(view);
        expect(answer.ids).toEqual(ids);
        expect(answer.elements).toEqual(elements);
        expect(answer.instances).toEqual(answer.elements);
    });

    it('view of the selected placements: the cards and the edges with a bounded number of store reads, not six per placement', () => {
        const { answer, sparql, reads } = measure('view', () => store.reads.view(view, [...ids, ...[...Array(EDGES).keys()].map(i => iriId(edge(i)))]));
        expect(sparql).toBeLessThanOrEqual(20);
        expect(reads).toBeLessThanOrEqual(PER_INSTANCE + 100);
        expect(answer!.boxes.filter(b => b.kind === 'card')).toHaveLength(N);
        expect(answer!.edges.filter(e => e.id)).toHaveLength(EDGES);
        expect(answer).toEqual(store.reads.view(view));
    });

    it('links: the rows of each element with a bounded number of store reads, not one instance test per row', () => {
        const { answer, sparql, reads } = measure('links', () => store.reads.links(ids, view));
        expect(sparql).toBeLessThanOrEqual(25);
        expect(reads).toBeLessThanOrEqual(PER_INSTANCE + 100);
        expect(answer.elements).toHaveLength(N);
        expect(answer.rows.filter(r => r.dir === 'out' && r.predicate === KNOWS)).toHaveLength(N - 1);
        expect(answer.rows.filter(r => r.dir === 'in' && r.predicate === KNOWS)).toHaveLength(N - 1);
        expect(answer.rows.filter(r => r.relation).map(r => r.relation)).toContain(relation(0));
        expect(answer.views).toHaveLength(N);
    });

    it('appearance: the hidden relations with a bounded number of store reads, not one per card or per relation', () => {
        const { answer, sparql, reads } = measure('appearance', () => store.reads.appearance(view, ids));
        expect(sparql).toBeLessThanOrEqual(25);
        expect(reads).toBeLessThanOrEqual(PER_INSTANCE + 100);
        expect(answer!.hidden).toHaveLength(N - 1 - EDGES);
        expect(answer!.hidden[0]).toEqual({ id: relation(EDGES), label: `Item ${EDGES} — knows → Item ${EDGES + 1}` });
    });

    it('outline: the nodes of each card from the view statements indexed once, in time linear in the placements', () => {
        const { answer, sparql, ms } = measure('outline', () => store.reads.outline(view, { view, ids: ids.slice(0, 3) }));
        expect(sparql).toBeLessThanOrEqual(8);
        expect(ms).toBeLessThan(1000);
        expect(answer).toHaveLength(N);
        expect(answer.filter(n => n.selected)).toHaveLength(3);
        expect(answer[0].children.map(c => c.kind)).toEqual(['out']);
        expect(answer[1].children.map(c => c.kind)).toEqual(['out', 'in']);
    });

    it('elementRows, occurrence, unplaced and deletePlan: a bounded number of store reads each', { timeout: 10_000 }, () => {
        const rows = measure('elementRows', () => store.reads.elementRows(ids, view));
        expect(rows.sparql).toBeLessThanOrEqual(20);
        expect(rows.reads).toBeLessThanOrEqual(PER_INSTANCE + 100);
        expect(rows.answer).toHaveLength(N);
        const occurrence = measure('occurrence', () => store.reads.occurrence(ids, view));
        expect(occurrence.sparql).toBeLessThanOrEqual(25);
        expect(occurrence.reads).toBeLessThanOrEqual(PER_INSTANCE + 100);
        const unplaced = measure('unplaced', () => store.reads.unplaced(elements));
        expect(unplaced.sparql).toBeLessThanOrEqual(25);
        expect(unplaced.reads).toBeLessThanOrEqual(PER_INSTANCE + 100);
        expect(unplaced.answer).toEqual([]);
        const plan = measure('deletePlan', () => store.reads.deletePlan(elements));
        expect(plan.sparql).toBeLessThanOrEqual(30);
        expect(plan.reads).toBeLessThanOrEqual(PER_INSTANCE + 100);
        expect(plan.answer.lines.length).toBeGreaterThan(0);
    });

    it('explorerDrag of a file: the file test of each element with a bounded number of store reads, not one per element', () => {
        const { answer, sparql, reads } = measure('explorerDrag', () => store.reads.explorerDrag({ ids: elements, folders: [], file: 'data.ttl' }));
        expect(sparql).toBeLessThanOrEqual(6);
        expect(reads).toBeLessThanOrEqual(20);
        expect(answer).toEqual(elements);
        expect(store.reads.explorerDrag({ ids: elements, folders: [], file: 'shapes.ttl' })).toEqual([]);
    });
});
