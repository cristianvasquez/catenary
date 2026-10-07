import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Doc, boxes, deletePlan, elementRows, knownPredicates, neighborChoices, occurrence, relationChoices, showing } from '@catenary/model';
import { hiddenNeighborCounts, instancesNamed, knownClasses, memberOptions, unplacedInstances, unplacedRelations } from '../../model/test/doc-reference';
import { ModelStore } from '../src/model-store';
import { project } from './project-full';
import { DATA, SHAPES, docOf, writeWorkspace } from './helpers';

// ADR 0012: the store answers each request from a request-scoped read model (scoped-doc.ts). Oracle: the same pure functions of
// @catenary/model on the read model of the whole dataset (project-full.ts, test only), for every element of the fixture workspace.

let dir: string, store: ModelStore, doc: Doc;
beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-scoped-'));
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
    // More views: a part of the instances with a collection, a note, an arrow and a reference; the shapes with a value set.
    const first = docOf(store), main = Object.values(first.views)[0];
    const ok = (r: ReturnType<ModelStore['execute']>) => { if (!r.ok) throw new Error(r.error); return r; };
    const part = ok(store.execute({ kind: 'createView', label: 'Part' })).id!;
    const some = Object.keys(first.instances).slice(0, 4);
    ok(store.execute({ kind: 'addToView', view: part, ids: some, at: { x: 0, y: 0 } }));
    ok(store.execute({ kind: 'collect', view: part, ids: some.slice(0, 2) }));
    const note = ok(store.execute({ kind: 'createNote', view: part, text: 'A note', at: { x: 900, y: 0 } })).id!;
    ok(store.execute({ kind: 'createArrow', view: part, from: note, to: some[2] }));
    ok(store.execute({ kind: 'addViewReference', view: part, target: main.id, at: { x: 900, y: 400 } }));
    const shapesView = ok(store.execute({ kind: 'createView', label: 'Shapes' })).id!;
    ok(store.execute({ kind: 'addToView', view: shapesView, ids: Object.keys(first.shapes.nodeShapes).slice(0, 3), at: { x: 0, y: 0 } }));
    const scheme = ok(store.execute({ kind: 'createValueSet', valueSet: 'scheme', label: 'Colors', view: shapesView, at: { x: 1200, y: 0 } })).id!;
    ok(store.execute({ kind: 'addConcept', set: scheme, label: 'Red' }));
    doc = docOf(store);
});
afterAll(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const views = () => Object.values(doc.views);
const elements = () => [
    ...Object.keys(doc.instances), ...Object.keys(doc.relations), ...Object.keys(doc.views),
    ...Object.keys(doc.shapes.nodeShapes), ...Object.keys(doc.shapes.valueSets), ...Object.keys(doc.shapes.properties), ...Object.keys(doc.shapes.constraints)
];

describe('request-scoped read models give the answers of the whole read model', () => {
    it('the fixture has instances, relations, several views and shapes', () => {
        expect(Object.keys(doc.instances).length).toBeGreaterThan(5);
        expect(Object.keys(doc.relations).length).toBeGreaterThan(3);
        expect(views().length).toBeGreaterThan(1);
        expect(Object.keys(doc.shapes.nodeShapes).length).toBeGreaterThan(1);
        expect(Object.keys(doc.shapes.valueSets).length).toBeGreaterThan(0);
        expect(views().flatMap(v => boxes(v, 'collection')).length).toBeGreaterThan(0);
    });

    it('showing, deletePlan and unplaced of each element', () => {
        const unplaced = new Set([...unplacedInstances(doc), ...unplacedRelations(doc)]);
        for (const id of elements()) {
            expect(store.showing(id), id).toEqual(showing(doc, id));
            expect(store.deletePlan([id]), id).toEqual(deletePlan(doc, store.meta, [id]));
            expect(store.unplaced([id]), id).toEqual(unplaced.has(id) ? [id] : []);
        }
        const all = elements();
        expect(store.deletePlan(all)).toEqual(deletePlan(doc, store.meta, all));
    });

    // This compares every element against each view; Node 22 can exceed Vitest's default timeout. The test yields after each view: a
    // worker that runs for a minute without a break misses the replies of Vitest ("Timeout calling onTaskUpdate"). The Windows runner
    // takes several times longer than Linux for this test.
    it('occurrence and element rows of each element and each placement, in each view', async () => {
        for (const view of views()) {
            await new Promise(resolve => setImmediate(resolve));
            const ids = [...elements(), ...view.boxes.map(b => b.id), ...view.edges.flatMap(e => e.id ? [e.id] : []), ...view.arrows.map(a => a.id)];
            for (const id of ids) {
                expect(store.occurrence([id], view.id), `${view.id} ${id}`).toEqual(occurrence(doc, store.meta, [id], view.id));
                expect(store.elementRows([id], view.id), `${view.id} ${id}`).toEqual(elementRows(doc, store.meta, [id], view.id));
            }
        }
        for (const id of elements()) expect(store.elementRows([id]), id).toEqual(elementRows(doc, store.meta, [id]));
    }, process.platform === 'win32' ? 300_000 : 60_000);

    it('neighbor choices and halo counts of each card', () => {
        for (const view of views()) {
            const counts = hiddenNeighborCounts(doc, view);
            const mine = store.hiddenNeighborCounts(view);
            for (const card of boxes(view, 'card')) {
                if (!doc.instances[card.element]) continue;
                expect(mine.get(card.element), card.element).toEqual(counts.get(card.element));
                for (const dir of ['in', 'out'] as const) {
                    expect(store.neighborChoices(view.id, card.id, dir), `${card.id} ${dir}`).toEqual(neighborChoices(doc, store.meta, view.id, card.id, dir));
                }
            }
        }
    });

    it('relation choices of each pair of instances', () => {
        const ids = Object.keys(doc.instances);
        for (const s of ids) for (const t of ids) expect(store.relationChoices(s, t), `${s} ${t}`).toEqual(relationChoices(doc, store.meta, s, t));
    });

    it('known classes, known predicates, member options and instances by name', () => {
        const sorted = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => key(a).localeCompare(key(b)));
        expect(sorted(store.knownClasses(), c => c.iri)).toEqual(sorted(knownClasses(doc, store.meta).filter((c, i, all) => all.findIndex(x => x.iri === c.iri && x.name === c.name) === i), c => c.iri));
        expect(new Set(store.knownPredicates().map(p => p.iri))).toEqual(new Set(knownPredicates(doc, store.meta).map(p => p.iri)));
        for (const view of views()) for (const c of boxes(view, 'collection')) expect(store.memberOptions(view.id, c.id)).toEqual(memberOptions(doc, view.id, c.id));
        for (const i of Object.values(doc.instances)) {
            expect(store.instancesNamed(i.label), i.label).toEqual(instancesNamed(doc, i.label));
            expect(store.instancesNamed(i.uri), i.uri).toEqual(instancesNamed(doc, i.uri));
        }
    });

    it('the instance count of the snapshot and the warnings of the open', () => {
        expect(store.snapshot().counts.instances).toBe(Object.keys(doc.instances).length);
        const g = (store as unknown as { graph: Parameters<typeof project>[0] }).graph;
        for (const w of project(g).warnings) expect(store.warnings, w).toContain(w);
    });

    it('a node shape IRI change is a moved id (moved-ids.ts), for the edit and its undo', () => {
        const old = Object.keys(doc.shapes.nodeShapes)[0];
        const r = store.execute({ kind: 'setUri', id: old, uri: 'https://ex.org/moved-shape' });
        if (!r.ok) throw new Error(r.error);
        expect(store.snapshot().movedIds).toEqual({ [old]: r.id });
        store.undo();
        expect(store.snapshot().movedIds).toEqual({ [r.id!]: old });
    });
});
