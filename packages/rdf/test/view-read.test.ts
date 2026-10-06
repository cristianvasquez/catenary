import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Doc, EditCommand, boxes, toSchema } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { OxigraphStore } from 'rdf-files';
import { project } from './project-full';
import { rdf } from '../src/terms';
import { showsShapes } from '../src/view-read';
import { ModelGraph } from '../src/graph';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';
import { viewPart } from './view-part-reference';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
let dir: string, store: ModelStore;
afterEach(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

async function openFixtures(): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'catenary-view-read-'));
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
}

async function openDcat(): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'catenary-view-read-'));
    for (const [from, to] of [['dcat-workspace.trig', 'workspace.trig'], ['dcat-data.ttl', 'data.ttl'], ['dcat-shapes.ttl', 'shapes.ttl']]) cpSync(FIXTURES + from, join(dir, to));
    cpSync(FIXTURES + 'dcat-views', join(dir, 'dcat-views'), { recursive: true });
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
}

/** The Doc of a view on the path before ADR 0007 step 5: the part query into a store, then the projection. */
function byProjection(viewId: string): Doc {
    const g = store['graph'];
    const view = docOf(store).views[viewId];
    const part = new ModelGraph(new OxigraphStore(viewPart(g, rdf.namedNode(view.uri))));
    part.model = g.model;
    part.setShapesGraphs(g.shapesGraphs());
    part.primaryShapes = g.primaryShapes;
    return store['decorate'](project(part).doc);
}

const schema = (doc: Doc, viewId: string, showHidden: boolean) => {
    const schemes = new Map((store.meta.schemes ?? []).map(x => [x.iri, x.label]));
    return toSchema(doc, store.meta, viewId, {
        showHidden, violations: store.violations, schemeLabel: iri => schemes.get(iri) ?? iri.replace(/^.*[#/:]/, ''), notation: store.viewFigures(viewId)
    });
};

/**
 * For every view: the graph of the new path equals the graph of the old path (with and without hidden edges); the views, instances and
 * relations of the Docs are equal too. The shapes model: equal for a view with shape elements; a view without them now gets the shapes
 * model of the store (before: the shapes read from the part, about empty), and draws no shape element with either.
 */
function sameAsProjection(): number {
    const views = Object.keys(docOf(store).views);
    expect(views.length).toBeGreaterThan(0);
    for (const id of views) {
        const now = store.viewDoc(id), before = byProjection(id);
        for (const showHidden of [false, true]) expect(schema(now, id, showHidden)).toEqual(schema(before, id, showHidden));
        if (now.views[id].boxes.length) expect(schema(now, id, true).children!.length).toBeGreaterThan(0);
        expect(now.views).toEqual(before.views);
        expect(now.instances).toEqual(before.instances);
        expect(now.relations).toEqual(before.relations);
        if (showsShapes(store['graph'], rdf.namedNode(now.views[id].uri))) expect(now.shapes).toEqual(before.shapes);
    }
    return views.length;
}

function edit(command: EditCommand): string | undefined {
    const r = store.execute(command);
    if (!r.ok) throw new Error(r.error);
    return r.id;
}

describe('view diagram from SPARQL rows (ADR 0007 step 5)', () => {
    it('fixture views: the graph equals the graph of the part projection, also after edits', async () => {
        await openFixtures();
        expect(sameAsProjection()).toBe(1);
        const view = Object.values(docOf(store).views)[0];
        const [a, b, c] = boxes(view, 'card');
        const placed = view.edges.find(e => e.id)!;
        // Move, resize, color, display, sides.
        edit({ kind: 'setBounds', view: view.id, bounds: [{ id: a.id, x: a.x + 40, y: a.y + 30 }, { id: b.id, width: b.width + 50, height: b.height + 20 }] });
        edit({ kind: 'setViewElements', view: view.id, ids: [c.id], patch: { color: '#aabbcc', display: 'simple' } });
        edit({ kind: 'setEdgeLayout', view: view.id, relation: placed.relation, patch: { fromSide: 'left', toSide: 'right', color: '#112233' } });
        sameAsProjection();
        // Hide an edge; group; note, arrow, view reference, file reference; collect.
        edit({ kind: 'hideEdges', view: view.id, ids: [placed.relation], hidden: true });
        edit({ kind: 'createGroup', view: view.id, label: 'Around', around: [a.id, b.id] });
        const note = edit({ kind: 'createNote', view: view.id, text: 'A note', at: { x: 10, y: 10 } })!;
        edit({ kind: 'createArrow', view: view.id, from: note, to: c.id });
        const other = edit({ kind: 'createView', label: 'Other' })!;
        edit({ kind: 'addViewReference', view: view.id, target: other, at: { x: 50, y: 900 } });
        edit({ kind: 'addFileReference', view: view.id, file: 'data.ttl', at: { x: 400, y: 900 } });
        edit({ kind: 'collect', view: view.id, ids: [a.id, b.id] });
        expect(sameAsProjection()).toBe(2);
        const now = store.viewDoc(view.id).views[view.id];
        expect(['group', 'note', 'reference', 'collection'].map(k => boxes(now, k as 'group').length)).toEqual([boxes(view, 'group').length + 1, 1, 2, 1]);
        expect(now.arrows.length).toBe(1);
        // collect removed the placements of the member relations: they are part of the bundle of the group, not hidden.
        const members = new Set(boxes(now, 'collection').flatMap(c => c.members));
        const memberEdges = now.edges.filter(e => { const r = store.viewDoc(view.id).relations[e.relation]; return r && (members.has(r.subject) || members.has(r.object)); });
        expect(memberEdges.length).toBeGreaterThan(0);
        expect(memberEdges.every(e => !e.hidden && !e.id)).toBe(true);
        // Rename of the referenced view: the reference label follows.
        edit({ kind: 'rename', id: other, label: 'Renamed' });
        sameAsProjection();
        expect(store.viewDoc(view.id).views[other].label).toBe('Renamed');
    });

    it('dcat views (shape elements, value sets): the graph equals the graph of the part projection', async () => {
        await openDcat();
        expect(sameAsProjection()).toBe(2);
        const shapesView = Object.values(docOf(store).views).find(v => boxes(v, 'card').some(n => docOf(store).shapes.nodeShapes[n.element]))!;
        expect(shapesView).toBeDefined();
        const card = boxes(shapesView, 'card')[0];
        edit({ kind: 'setBounds', view: shapesView.id, bounds: [{ id: card.id, x: card.x + 100 }] });
        edit({ kind: 'createNote', view: shapesView.id, text: 'Shapes note', at: { x: 0, y: 0 } });
        sameAsProjection();
    });

    it('no view: an empty Doc', async () => {
        await openFixtures();
        expect(store.viewDoc('urn:x:no-view').views).toEqual({});
    });
});
