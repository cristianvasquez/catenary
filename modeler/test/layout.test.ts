import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import ELK, { ElkNode } from 'elkjs/lib/elk.bundled.js';
import { LAYOUT_ALGORITHMS } from '../src/common/protocol';
import { Box, Doc, TYPES, groupOf, inside, emptyShapes, iriId, boxes, toSchema } from '@catenary/model';
import { ModelStore } from '@catenary/rdf';
import { layoutView } from '../src/node/glsp/layout';
import { docOf } from '../../packages/rdf/test/helpers';

it.each(LAYOUT_ALGORITHMS.map(a => a.id))('%s: lays out a view without overlap, preserving group membership, box sizes and the source document', async algorithm => {
    const nodes = [
        { kind: 'card' as const, id: 'a', element: 'a', x: 40, y: 60, width: 120, height: 80 },
        { kind: 'card' as const, id: 'b', element: 'b', x: 250, y: 60, width: 120, height: 80 },
        { kind: 'card' as const, id: 'outside', element: 'outside', x: 700, y: 0, width: 120, height: 80 }
    ];
    const group = { kind: 'group' as const, id: 'group', label: 'Group', x: 0, y: 0, width: 600, height: 350 };
    const note = { kind: 'note' as const, id: 'note', text: 'Keep this inside', x: 40, y: 200, width: 120, height: 60 };
    const doc: Doc = {
        instances: Object.fromEntries(nodes.map(n => [n.id, { id: n.id, uri: `urn:${n.id}`, label: n.id, types: [], fields: {} }])),
        relations: { ab: { id: 'ab', subject: 'a', predicate: 'urn:rel', object: 'b' } },
        views: { v: { id: 'v', uri: 'urn:v', label: 'View', boxes: [...nodes, group, note], edges: [], arrows: [] } },
        shapes: emptyShapes()
    };
    const before = structuredClone(doc);
    const result = await layoutView(doc, 'v', false, algorithm);
    const box = (id: string) => result.bounds.find(b => b.id === id)!;
    const original = [...nodes, group, note];
    expect(result.bounds.map(b => b.id).sort()).toEqual(original.map(b => b.id).sort());
    for (const old of original) {
        expect(box(old.id)).toMatchObject({ width: old.width, height: old.height });
        if (old.id !== group.id) expect(inside(box(old.id), box(group.id))).toBe(inside(old, group));
    }
    const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const content = ['a', 'b', 'outside', 'note'];
    for (const [i, a] of content.entries()) for (const b of content.slice(i + 1)) expect(overlap(box(a), box(b))).toBe(false);
    expect(result.edges).toEqual(['ab']);
    expect(doc).toEqual(before);
});

it.each(LAYOUT_ALGORITHMS.map(a => a.id))('%s: 40 connected cards get no overlap', async algorithm => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({ kind: 'card' as const, id: `c${i}`, element: `c${i}`, x: (i * 37) % 500, y: (i * 53) % 400, width: 320, height: 160 }));
    const relations = Object.fromEntries(nodes.slice(1).map((n, i) => [`r${i}`, { id: `r${i}`, subject: `c${Math.floor(i / 3)}`, predicate: 'urn:rel', object: n.id }]));
    const doc: Doc = {
        instances: Object.fromEntries(nodes.map(n => [n.id, { id: n.id, uri: `urn:${n.id}`, label: n.id, types: [], fields: {} }])),
        relations,
        views: { v: { id: 'v', uri: 'urn:v', label: 'View', boxes: nodes, edges: [], arrows: [] } },
        shapes: emptyShapes()
    };
    const { bounds } = await layoutView(doc, 'v', false, algorithm);
    const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const [i, a] of bounds.entries()) for (const b of bounds.slice(i + 1)) expect(overlap(a, b), `${a.id} ${b.id}`).toBe(false);
});

// The SHACL view of the notation fixture (ADR 0014): an "in" box and a "one of" box (placed by their list terms), a hub whose two member
// lines end at private pills, a value set. The layout places the list boxes (`<property>_leaf`, setBounds places their list), and a
// private pill moves with its card: it is part of the extent of the card and gets no bounds.
it.each(['layered', 'force'] as const)('%s: list boxes are laid out; private pills go with their card', async algorithm => {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-layout-'));
    cpSync('packages/rdf/test/fixtures/notation', dir, { recursive: true });
    const store = new ModelStore();
    store.watching = false;
    expect(await store.open(join(dir, 'workspace.trig'))).toMatchObject({ ok: true });
    const viewId = iriId('urn:view:shapes');
    const children = toSchema(store.viewDoc(viewId), { classes: [] }, viewId, { showHidden: false, violations: [], notation: store.viewFigures(viewId) }).children!;
    const lists = children.filter(c => c.type === TYPES.LEAF && !c.private).map(c => c.id);
    const privates = children.filter(c => c.type === TYPES.LEAF && c.private).map(c => c.id);
    expect(lists).toHaveLength(2);
    expect(privates).toHaveLength(2);
    const { bounds, edges } = await layoutView(store.viewDoc(viewId), viewId, false, algorithm, 120, 1, store.viewFigures(viewId));
    expect(bounds.map(b => b.id)).toEqual(expect.arrayContaining(lists));
    expect(bounds.map(b => b.id).filter(id => privates.includes(id))).toEqual([]);
    expect(store.execute({ kind: 'setLayout', view: viewId, bounds, clearSides: edges })).toMatchObject({ ok: true });
    const nodes = drawn(store, viewId, 1);
    const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const [i, a] of nodes.entries()) for (const b of nodes.slice(i + 1)) if (!privates.includes(a.id) && !privates.includes(b.id)) expect(overlap(a, b), `${a.id} ${b.id}`).toBe(false);
    // The list boxes keep their place after the layout: setBounds moved their placements.
    for (const id of lists) expect(nodes.find(n => n.id === id)).toMatchObject({ x: bounds.find(b => b.id === id)!.x, y: bounds.find(b => b.id === id)!.y });
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

// The fixture has cards in groups. cola.removeOverlaps alone left two cards of a group on top of each other (after the former Flow layout).
it('fixture: each algorithm in turn leaves no overlapping cards and keeps group membership', async () => {
    // A copy: the store writes each edit to its files (ADR 0003).
    const dir = mkdtempSync(join(tmpdir(), 'catenary-layout-'));
    cpSync('packages/rdf/test/fixtures', dir, { recursive: true });
    const store = new ModelStore();
    expect(await store.open(join(dir, 'workspace.trig'))).toMatchObject({ ok: true });
    const viewId = Object.keys(docOf(store).views)[0];
    const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const membership = () => { const v = docOf(store).views[viewId]; return boxes(v, 'card').map(n => groupOf(v, n, n.id)?.id); };
    const before = membership();
    for (const algorithm of [...LAYOUT_ALGORITHMS.map(a => a.id), ...LAYOUT_ALGORITHMS.map(a => a.id)]) {
        const { bounds, edges } = await layoutView(store.viewDoc(viewId), viewId, false, algorithm);
        expect(store.execute({ kind: 'setLayout', view: viewId, bounds, clearSides: edges })).toMatchObject({ ok: true });
        const nodes = boxes(docOf(store).views[viewId], 'card');
        for (const [i, a] of nodes.entries()) for (const b of nodes.slice(i + 1)) expect(overlap(a, b), `${algorithm}: ${a.id} ${b.id}`).toBe(false);
        expect(membership(), algorithm).toEqual(before);
    }
    await store.idle();
    rmSync(dir, { recursive: true, force: true });
});

it('force ends when cola leaves boxes that touch (1e-6 overlap)', async () => {
    // A view of the ui-manifest workspace: 12 equal cards on a grid. cola.removeOverlaps left two boxes with an overlap of 1e-6; the
    // correction moved one by 1e-14, which did not change its coordinates, and the loop did not end.
    const cells = [[1920, 0], [0, 0], [1920, 840], [800, 0], [1920, 420], [800, 420], [0, 840], [1360, 420], [1360, 0], [0, 420], [800, 840], [1360, 840]];
    const pairs = [[0, 1], [2, 6], [3, 1], [4, 9], [5, 9], [7, 9], [8, 1], [10, 6], [11, 6]];
    const nodes = cells.map(([x, y], i) => ({ kind: 'card' as const, id: `c${i}`, element: `c${i}`, x, y, width: 460, height: 260 }));
    const doc: Doc = {
        instances: Object.fromEntries(nodes.map(n => [n.id, { id: n.id, uri: `urn:${n.id}`, label: n.id, types: [], fields: {} }])),
        relations: Object.fromEntries(pairs.map(([s, o], i) => [`r${i}`, { id: `r${i}`, subject: `c${s}`, predicate: 'urn:rel', object: `c${o}` }])),
        views: { v: { id: 'v', uri: 'urn:v', label: 'View', boxes: nodes, edges: [], arrows: [] } },
        shapes: emptyShapes()
    };
    const { bounds } = await layoutView(doc, 'v', false, 'force');
    expect(bounds).toHaveLength(12);
});

it.each(LAYOUT_ALGORITHMS.flatMap(a => [40, 300].map(spacing => [a.id, spacing] as const)))('%s with spacing %i: every two boxes are at least that far apart', async (algorithm, spacing) => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ kind: 'card' as const, id: `c${i}`, element: `c${i}`, x: (i * 37) % 300, y: (i * 53) % 200, width: 260, height: 120 }));
    const relations = Object.fromEntries(nodes.slice(1).map((n, i) => [`r${i}`, { id: `r${i}`, subject: `c${Math.floor(i / 2)}`, predicate: 'urn:rel', object: n.id }]));
    const doc: Doc = {
        instances: Object.fromEntries(nodes.map(n => [n.id, { id: n.id, uri: `urn:${n.id}`, label: n.id, types: [], fields: {} }])),
        relations,
        views: { v: { id: 'v', uri: 'urn:v', label: 'View', boxes: nodes, edges: [], arrows: [] } },
        shapes: emptyShapes()
    };
    const { bounds } = await layoutView(doc, 'v', false, algorithm, spacing);
    // Distance between two boxes: the larger of the x gap and the y gap (negative: they overlap on that axis). Rounding: 1 px.
    const gap = (a: Box, b: Box) => Math.max(Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width), Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
    for (const [i, a] of bounds.entries()) for (const b of bounds.slice(i + 1)) expect(gap(a, b), `${a.id} ${b.id}`).toBeGreaterThanOrEqual(spacing - 1);
});

/** The drawn boxes of a view (toSchema, as the GLSP model): cards, shapes, value sets, collections, pills, notes. Not groups and logic circles. */
function drawn(store: ModelStore, viewId: string, cardScale: number): ({ id: string } & Box)[] {
    const root = toSchema(store.viewDoc(viewId), { classes: [] }, viewId, { showHidden: false, cardScale, violations: [], notation: store.viewFigures(viewId) });
    return (root.children ?? []).filter(c => c.type.startsWith('node:') && c.type !== TYPES.GROUP && c.type !== TYPES.LOGIC)
        .map(c => ({ id: c.id, ...(c.position as { x: number; y: number }), ...(c.size as { width: number; height: number }) }));
}

// Shape and value set cards are drawn taller than their stored box (one row per property, card text scale). The layout used the stored
// box: in the fixture, Force left two drawn shape cards on top of each other at scale 1; the ui-manifest Shapes view had 3 (Layered) and
// 4 (Force) overlaps at the card text scale 42/22. These fixture layouts can exceed Vitest's default timeout on Node 22.
it.each(LAYOUT_ALGORITHMS.flatMap(a => [1, 2].map(scale => [a.id, scale] as const)))('%s at card text scale %d: no drawn boxes overlap, pills included', async (algorithm, scale) => {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-layout-'));
    cpSync('packages/rdf/test/fixtures', dir, { recursive: true });
    const store = new ModelStore();
    expect(await store.open(join(dir, 'workspace.trig'))).toMatchObject({ ok: true });
    const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const viewId of Object.keys(docOf(store).views)) {
        const { bounds, edges } = await layoutView(store.viewDoc(viewId), viewId, false, algorithm, 120, scale, store.viewFigures(viewId));
        expect(store.execute({ kind: 'setLayout', view: viewId, bounds, clearSides: edges })).toMatchObject({ ok: true });
        const nodes = drawn(store, viewId, scale);
        for (const [i, a] of nodes.entries()) for (const b of nodes.slice(i + 1)) expect(overlap(a, b), `${docOf(store).views[viewId].label}: ${a.id} ${b.id}`).toBe(false);
    }
    await store.idle();
    rmSync(dir, { recursive: true, force: true });
}, 15_000);

// ELK layered packs unlinked components in rows that come out tall: 10 unlinked cards of 400 × 180 gave 2 columns and 5 rows (880 × 2100
// in the ui-manifest Overview view). The components are packed near the aspect ratio 1.6.
it.each(LAYOUT_ALGORITHMS.map(a => a.id))('%s: unlinked cards are packed wider than tall', async algorithm => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({ kind: 'card' as const, id: `c${i}`, element: `c${i}`, x: i * 500, y: 0, width: 400, height: 180 }));
    const doc: Doc = {
        instances: Object.fromEntries(nodes.map(n => [n.id, { id: n.id, uri: `urn:${n.id}`, label: n.id, types: [], fields: {} }])),
        relations: {},
        views: { v: { id: 'v', uri: 'urn:v', label: 'View', boxes: nodes, edges: [], arrows: [] } },
        shapes: emptyShapes()
    };
    const { bounds } = await layoutView(doc, 'v', false, algorithm);
    const width = Math.max(...bounds.map(b => b.x + b.width)) - Math.min(...bounds.map(b => b.x));
    const height = Math.max(...bounds.map(b => b.y + b.height)) - Math.min(...bounds.map(b => b.y));
    expect(width / height).toBeGreaterThanOrEqual(1);
    const again = await layoutView(doc, 'v', false, algorithm);
    expect(again.bounds).toEqual(bounds);
});

it('layered: if ELK layered fails, ELK box places the cards (no overlap)', async () => {
    const proto = ELK.prototype as unknown as { layout: (graph: ElkNode, ...rest: unknown[]) => Promise<ElkNode> };
    const real = proto.layout;
    const spy = vi.spyOn(proto, 'layout').mockImplementation(function (this: unknown, graph: ElkNode, ...rest: unknown[]) {
        if (graph.layoutOptions?.['elk.algorithm'] === 'layered') return Promise.reject(new Error('stack overflow'));
        return real.call(this, graph, ...rest);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const nodes = Array.from({ length: 4 }, (_, i) => ({ kind: 'card' as const, id: `c${i}`, element: `c${i}`, x: 0, y: 0, width: 200, height: 100 }));
    const doc: Doc = {
        instances: Object.fromEntries(nodes.map(n => [n.id, { id: n.id, uri: `urn:${n.id}`, label: n.id, types: [], fields: {} }])),
        relations: Object.fromEntries([1, 2, 3].map(i => [`r${i}`, { id: `r${i}`, subject: 'c0', predicate: 'urn:rel', object: `c${i}` }])),
        views: { v: { id: 'v', uri: 'urn:v', label: 'View', boxes: nodes, edges: [], arrows: [] } },
        shapes: emptyShapes()
    };
    const { bounds } = await layoutView(doc, 'v', false, 'layered');
    expect(spy.mock.calls.some(([g]) => g.layoutOptions?.['elk.algorithm'] === 'box')).toBe(true);
    const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(bounds).toHaveLength(4);
    for (const [i, a] of bounds.entries()) for (const b of bounds.slice(i + 1)) expect(overlap(a, b)).toBe(false);
});
