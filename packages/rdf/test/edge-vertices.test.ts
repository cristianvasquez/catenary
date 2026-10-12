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

async function open(dcat = false): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'catenary-edge-vertices-'));
    store = new ModelStore();
    store.watching = false;
    if (dcat) {
        for (const [from, to] of [['dcat-workspace.trig', 'workspace.trig'], ['dcat-data.ttl', 'data.ttl'], ['dcat-shapes.ttl', 'shapes.ttl']]) cpSync(FIXTURES + from, join(dir, to));
        cpSync(FIXTURES + 'dcat-views', join(dir, 'dcat-views'), { recursive: true });
        expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
    } else {
        writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
        writeFileSync(join(dir, 'data.ttl'), DATA);
        expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
    }
}

function edit(command: EditCommand): void {
    const r = store.execute(command);
    if (!r.ok) throw new Error(r.error);
}

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
        edit({ kind: 'setLayout', view: view.id, bounds: [{ id: a.id, x: 0, y: 0 }], clearSides: [placed.relation] });
        expect(now().vertices).toBeUndefined();
    });

    it('a property shape drawn as an edge takes bends on its line placement', async () => {
        await open(true);
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
});
