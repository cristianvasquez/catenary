// The bends of an edge (UI §7.4): stored on the connector placement as one view:vertices literal, moved with both ends, cleared by Apply Layout.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EditCommand, NS, boxes, iriId, nkey } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { rdf } from '../src/terms';
import type { ModelGraph } from '../src/graph';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
let dir: string, store: ModelStore;
afterEach(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

async function open(fixture: 'base' | 'dcat' | 'notation' = 'base', data = DATA): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'catenary-edge-vertices-'));
    store = new ModelStore();
    store.watching = false;
    if (fixture === 'dcat') {
        for (const [from, to] of [['dcat-workspace.trig', 'workspace.trig'], ['dcat-data.ttl', 'data.ttl'], ['dcat-shapes.ttl', 'shapes.ttl']]) cpSync(FIXTURES + from, join(dir, to));
        cpSync(FIXTURES + 'dcat-views', join(dir, 'dcat-views'), { recursive: true });
        expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
    } else if (fixture === 'notation') {
        cpSync(FIXTURES + 'notation', dir, { recursive: true });
        expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
    } else {
        writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
        writeFileSync(join(dir, 'data.ttl'), data);
        expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
    }
}

function edit(command: EditCommand): void {
    const r = store.execute(command);
    if (!r.ok) throw new Error(r.error);
}

const allVertices = (view: string) => (store as unknown as { graph: ModelGraph }).graph.match(null, rdf.namedNode(NS.view + 'vertices'), null, rdf.namedNode(view)).map(q => q.object.value);
const literal = (view: string, placement: string) => (store as unknown as { graph: ModelGraph }).graph.match(null, rdf.namedNode(NS.view + 'vertices'), null, rdf.namedNode(view))
    .filter(q => iriId(q.subject.value) === placement).map(q => q.object.value);

describe('edge vertices (UI §7.4)', () => {
    it('a relation: one view:vertices literal, read back as points; [] removes it', async () => {
        await open();
        const view = Object.values(docOf(store).views)[0];
        const placed = view.edges.find(e => e.id)!;
        edit({ kind: 'setEdgeLayout', view: view.id, relation: placed.relation, patch: { vertices: [{ x: 10.4, y: 20 }, { x: -30, y: 40.6 }] } });
        expect(literal(view.uri, placed.id!)).toEqual(['10,20 -30,41']);
        const now = () => store.viewDoc(view.id).views[view.id].edges.find(e => e.relation === placed.relation)!;
        expect(now().vertices).toEqual([{ x: 10, y: 20 }, { x: -30, y: 41 }]);
        edit({ kind: 'setEdgeLayout', view: view.id, relation: placed.relation, patch: { vertices: [] } });
        expect(literal(view.uri, placed.id!)).toEqual([]);
        expect(now().vertices).toBeUndefined();
    });

    it('a move of both ends by one delta moves the bends; a move of one end keeps them; Apply Layout clears them', async () => {
        await open();
        const view = Object.values(docOf(store).views)[0];
        const placed = view.edges.find(e => e.id)!;
        const r = docOf(store).relations[placed.relation];
        const a = boxes(view, 'card').find(b => b.element === r.subject)!, b = boxes(view, 'card').find(b => b.element === r.object)!;
        const now = () => store.viewDoc(view.id).views[view.id].edges.find(e => e.relation === placed.relation)!;
        edit({ kind: 'setEdgeLayout', view: view.id, relation: placed.relation, patch: { vertices: [{ x: 100, y: 200 }] } });
        edit({ kind: 'setBounds', view: view.id, bounds: [{ id: a.id, x: a.x + 50, y: a.y + 10 }, { id: b.id, x: b.x + 50, y: b.y + 10 }] });
        expect(now().vertices).toEqual([{ x: 150, y: 210 }]);
        edit({ kind: 'setBounds', view: view.id, bounds: [{ id: a.id, x: a.x + 80, y: a.y + 10 }] });
        expect(now().vertices).toEqual([{ x: 150, y: 210 }]);
        edit({ kind: 'setBounds', view: view.id, bounds: [{ id: a.id, x: a.x + 80, y: a.y + 10 }, { id: b.id, x: b.x + 50, y: b.y + 10 }] });
        expect(now().vertices).toEqual([{ x: 150, y: 210 }]);
        edit({ kind: 'setLayout', view: view.id, bounds: [{ id: a.id, x: 0, y: 0 }] });
        expect(now().vertices).toBeUndefined();
    });

    it('a property shape drawn as an edge takes bends on its line placement', async () => {
        await open('dcat');
        const doc = docOf(store);
        const shapesView = Object.values(doc.views).find(v => boxes(v, 'card').some(n => doc.shapes.nodeShapes[n.element]))!;
        // Show a property with a node-shape range of a shown card as an edge: its line placement.
        const shown = new Set(boxes(shapesView, 'card').map(c => c.element));
        const property = Object.values(doc.shapes.properties).find(p => shown.has(p.owner) && p.range.kind === 'node' && !p.constraint)!;
        expect(property).toBeDefined();
        edit({ kind: 'showAsEdge', view: shapesView.id, id: property.id, at: { x: 900, y: 900 } });
        const vf = store.viewFigures(shapesView.id)!;
        const byUri = new Map(Object.values(doc.shapes.properties).map(p => [p.uri, p.id]));
        // A line with its own placement (not one that a hub draws).
        const line = vf.join.lines.filter(l => vf.placed.has(nkey(l.figure.placedAs))).map(l => byUri.get(l.figure.focus.value)).find((id): id is string => !!id)!;
        expect(line).toBe(property.id);
        edit({ kind: 'setEdgeLayout', view: shapesView.id, relation: line, patch: { vertices: [{ x: 1, y: 2 }] } });
        const placed = [...store.viewFigures(shapesView.id)!.placed.values()].filter(p => p.vertices);
        expect(placed.map(p => p.vertices)).toEqual([[{ x: 1, y: 2 }]]);
        expect(store.execute({ kind: 'setEdgeLayout', view: shapesView.id, relation: line, patch: { hidden: true } }).ok).toBe(false);
        expect(store.execute({ kind: 'setEdgeLayout', view: shapesView.id, relation: 'no-such-edge', patch: { vertices: [] } }).ok).toBe(false);
    });

    it('Apply Layout clears the bends of a self edge, which the layout links do not list', async () => {
        // A self statement of the first placed relation: the store reads it as a relation of the view (createRelation refuses one).
        await open('base');
        const first = Object.values(docOf(store).views)[0];
        const r0 = docOf(store).relations[first.edges.find(e => e.id)!.relation];
        const iri = docOf(store).instances[r0.subject].uri;
        await store.idle();
        store.close();
        rmSync(dir, { recursive: true, force: true });
        await open('base', DATA + `\n<${iri}> <${r0.predicate}> <${iri}> .\n`);
        const doc = docOf(store);
        const view = Object.values(doc.views)[0];
        const self = Object.values(doc.relations).find(r => r.subject === r.object)!;
        expect(self).toBeDefined();
        const card = boxes(view, 'card').find(b => b.element === self.subject)!;
        edit({ kind: 'setEdgeLayout', view: view.id, relation: self.id, patch: { vertices: [{ x: 5, y: 6 }], fromSide: 'top' } });
        expect(allVertices(view.uri)).toEqual(['5,6']);
        edit({ kind: 'setBounds', view: view.id, bounds: [{ id: card.id, x: card.x + 7, y: card.y + 8 }] });
        expect(allVertices(view.uri)).toEqual(['12,14']);
        edit({ kind: 'setLayout', view: view.id, bounds: [{ id: card.id, x: 0, y: 0 }] });
        expect(allVertices(view.uri)).toEqual([]);
        expect(store.viewDoc(view.id).views[view.id].edges.find(e => e.relation === self.id)?.fromSide).toBeUndefined();
    });

    it('a property edge: one moved end keeps its bends; a selection or a frame that moves both ends moves them; Apply Layout clears them', async () => {
        await open('dcat');
        const doc = docOf(store);
        const shapesView = Object.values(doc.views).find(v => boxes(v, 'card').some(n => doc.shapes.nodeShapes[n.element]))!;
        const shown = new Set(boxes(shapesView, 'card').map(c => c.element));
        const property = Object.values(doc.shapes.properties).find(p => shown.has(p.owner) && p.range.kind === 'node' && !p.constraint)!;
        const target = (property.range as { shape: string }).shape;
        edit({ kind: 'showAsEdge', view: shapesView.id, id: property.id, at: { x: 900, y: 900 } });
        edit({ kind: 'setEdgeLayout', view: shapesView.id, relation: property.id, patch: { vertices: [{ x: 100, y: 200 }] } });
        const view = () => store.viewDoc(shapesView.id).views[shapesView.id];
        const box = (element: string) => boxes(view(), 'card').find(b => b.element === element)!;
        const a = box(property.owner), b = box(target);
        expect(a && b).toBeTruthy();
        edit({ kind: 'setBounds', view: shapesView.id, bounds: [{ id: a.id, x: a.x + 80, y: a.y + 10 }] });
        expect(allVertices(shapesView.uri)).toEqual(['100,200']);
        // Both ends by (50, 10): the owner from its moved place, the target from its place.
        edit({ kind: 'setBounds', view: shapesView.id, bounds: [{ id: a.id, x: a.x + 130, y: a.y + 20 }, { id: b.id, x: b.x + 50, y: b.y + 10 }] });
        expect(allVertices(shapesView.uri)).toEqual(['150,210']);
        const [a2, b2] = [box(property.owner), box(target)];
        const x = Math.min(a2.x, b2.x) - 40, y = Math.min(a2.y, b2.y) - 40;
        edit({ kind: 'createGroup', view: shapesView.id, label: 'Both', rect: { x, y, width: Math.max(a2.x + a2.width, b2.x + b2.width) + 40 - x, height: Math.max(a2.y + a2.height, b2.y + b2.height) + 40 - y } });
        const frame = boxes(view(), 'group').find(f => f.label === 'Both')!;
        edit({ kind: 'setBounds', view: shapesView.id, bounds: [{ id: frame.id, x: frame.x + 30, y: frame.y - 40 }] });
        expect(box(property.owner)).toMatchObject({ x: a.x + 160, y: a.y - 20 });
        expect(allVertices(shapesView.uri)).toEqual(['180,170']);
        edit({ kind: 'setLayout', view: shapesView.id, bounds: [{ id: a.id, x: 0, y: 0 }] });
        expect(allVertices(shapesView.uri)).toEqual([]);
    });

    it('a member line of a hub (a private pill end) has no own placement: it takes no bends, and Apply Layout leaves none', async () => {
        await open('notation');
        const doc = docOf(store);
        const view = Object.values(doc.views).find(v => v.uri === 'urn:view:shapes')!;
        const member = Object.values(doc.shapes.properties).find(p => p.constraint && p.range.kind === 'datatype')!;
        expect(member).toBeDefined();
        const r = store.execute({ kind: 'setEdgeLayout', view: view.id, relation: member.id, patch: { vertices: [{ x: 1, y: 1 }] } });
        expect(r.ok).toBe(false);
        const card = boxes(view, 'card').find(b => b.element === member.owner)!;
        edit({ kind: 'setLayout', view: view.id, bounds: [{ id: card.id, x: 10, y: 10 }] });
        expect(allVertices(view.uri)).toEqual([]);
    });
});
