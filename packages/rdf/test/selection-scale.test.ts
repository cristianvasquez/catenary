// The selection reads of a few hundred selected placements (spec/manifest.hs §11.3 readBudgetMs): a bounded number of queries, not
// one or more per selected id. The tracer counts the SPARQL queries of the store (report-read.test.ts pattern).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NS, iriId } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { tracer } from '../src/trace';
import { WORKSPACE } from './helpers';

const N = 300;
const THING = 'urn:x:Thing', LOOSE = 'urn:x:Loose', VIEW = 'urn:name:Big';
const instance = (i: number) => `urn:x:i${String(i).padStart(4, '0')}`;
const placement = (i: number) => `${VIEW}/p/${String(i).padStart(4, '0')}`;

const SHAPES = `@prefix sh: <${NS.sh}> .
<urn:x:ThingShape> a sh:NodeShape ; sh:targetClass <${THING}> ; sh:name "Thing" ;
  sh:property [ sh:path <${NS.rdfs}label> ; sh:datatype <http://www.w3.org/2001/XMLSchema#string> ] .
`;
// Even instances: Thing (a node shape targets it). Odd instances: Loose (no node shape).
const DATA = [...Array(N).keys()].map(i => `<${instance(i)}> a <${i % 2 ? LOOSE : THING}> ; <${NS.rdfs}label> "Item ${i}" .`).join('\n');
const VIEW_FILE = `<${VIEW}> {
  <${VIEW}> a <${NS.view}View> ; <${NS.rdfs}label> "Big" .
${[...Array(N).keys()].map(i => `  <${placement(i)}> a <${NS.view}Placement> ; <${NS.view}element> <${instance(i)}> ; <${NS.view}x> ${(i % 20) * 200} ; <${NS.view}y> ${Math.floor(i / 20) * 100} ; <${NS.view}view> <${VIEW}> .`).join('\n')}
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

const queries = () => tracer.take().spans.filter(s => s.kind === 'sparql');
const view = iriId(VIEW), ids = [...Array(N).keys()].map(i => iriId(placement(i)));

describe('selection reads of a few hundred placements (§11.3 law readBudgetMs)', () => {
    it('selectionActions: the facts of each item with a bounded number of queries, not two or more per id', { timeout: 10_000 }, () => {
        store.reads.selectionActions({ view, ids: ids.slice(0, 2), activeView: view });
        tracer.setClient(true);
        const answer = store.reads.selectionActions({ view, ids, activeView: view });
        expect(queries().length).toBeLessThanOrEqual(25);
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

    it('selected: each placement resolved to its instance with a bounded number of queries', () => {
        tracer.setClient(true);
        const answer = store.reads.selected({ view, ids });
        expect(queries().length).toBeLessThanOrEqual(4);
        expect(answer.view).toBe(view);
        expect(answer.ids).toEqual(ids);
        expect(answer.elements).toEqual(ids.map((_, i) => iriId(instance(i))));
        expect(answer.instances).toEqual(answer.elements);
    });
});
