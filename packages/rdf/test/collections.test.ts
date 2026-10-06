import { describe, expect, it } from 'vitest';
import { NS, TYPES, copyFromView, boxes, cardOf, idIri, toSchema } from '@catenary/model';
import { rdf } from '../src/terms';
import { executeCommand } from '../src/commands';
import { writeTrig } from '../src/trig';
import { doc, emptyGraph, load, run } from './helpers';

const meta = { classes: [] };

function setup() {
    const g = emptyGraph();
    const view = run(g, meta, { kind: 'createView', label: 'V' }) as string;
    const ids = ['A', 'B', 'C'].map((label, i) => run(g, meta, { kind: 'createInstance', classIri: 'urn:Class', label, view, at: { x: i * 400, y: 0 } }) as string);
    return { g, view, ids };
}

describe('collections (view only)', () => {
    it('collects cards into one collection at their center, as one undo step, and keeps it through a TriG round trip', async () => {
        const { g, view, ids } = setup();
        const { result, patch } = g.transact(x => executeCommand(x, meta, { kind: 'collect', view, ids: ids.slice(0, 2) }));
        expect(result.ok).toBe(true);
        const v = doc(g).views[view];
        expect(boxes(v, 'collection')).toMatchObject([{ members: ids.slice(0, 2).sort(), width: 320, height: 240 }]);
        // Cards A (x -160..160) and B (240..560): the center is x 200, y 0.
        expect(boxes(v, 'collection')[0]).toMatchObject({ x: 40, y: -120 });
        // A member has no placement of its own (ADR 0014, C1): only C keeps its card.
        expect(boxes(v, 'card').map(n => n.element)).toEqual([ids[2]]);
        g.undo(patch);
        expect(boxes(doc(g).views[view], 'card')).toHaveLength(3);
        expect(boxes(doc(g).views[view], 'collection')).toEqual([]);
        g.redo(patch);
        const after = Object.values(doc(await load(await writeTrig(g.quads()))).views)[0];
        expect(boxes(after, 'collection')).toHaveLength(1);
        expect(boxes(after, 'collection')[0].members).toHaveLength(2);
    });

    it('draws a new relation to a member as a bundle from the group, without a statement placement (nt:linkEnd)', () => {
        const { g, view, ids } = setup();
        const col = run(g, meta, { kind: 'collect', view, ids: ids.slice(0, 2) }) as string;
        // A data change: C urn:rel A (the shapes of this fixture permit no relation, so the statement is added directly).
        g.transact(x => { x.add(rdf.namedNode(idIri(ids[2])!), rdf.namedNode('urn:rel'), rdf.namedNode(idIri(ids[0])!), x.model); return { ok: true }; });
        expect(g.match(null, rdf.namedNode(NS.rdf + 'reifies'))).toEqual([]);
        const children = toSchema(doc(g), meta, view, { showHidden: false, violations: [] }).children ?? [];
        expect(children.filter(e => e.type === TYPES.BUNDLE)).toMatchObject([{ sourceId: cardOf(doc(g).views[view], ids[2])!.id, targetId: col, count: 1 }]);
    });

    it('takes members out next to the collection, and deletes it when empty', () => {
        const { g, view, ids } = setup();
        const id = run(g, meta, { kind: 'collect', view, ids }) as string;
        const box = boxes(doc(g).views[view], 'collection')[0];
        expect(run(g, meta, { kind: 'uncollect', view, id, ids: [ids[1]] })).toEqual([ids[1]]);
        let v = doc(g).views[view];
        expect(boxes(v, 'collection')[0].members).toEqual([ids[0], ids[2]].sort());
        expect(cardOf(v, ids[1])!.x).toBeGreaterThan(box.x + box.width);
        run(g, meta, { kind: 'uncollect', view, id });
        v = doc(g).views[view];
        expect(boxes(v, 'collection')).toEqual([]);
        expect(boxes(v, 'card')).toHaveLength(3);
    });

    it('merges selected collections into a new one', () => {
        const { g, view, ids } = setup();
        const first = run(g, meta, { kind: 'collect', view, ids: ids.slice(0, 2) }) as string;
        const merged = run(g, meta, { kind: 'collect', view, ids: [first, ids[2]] }) as string;
        const v = doc(g).views[view];
        expect(boxes(v, 'collection').map(c => c.id)).toEqual([merged]);
        expect(boxes(v, 'collection')[0].members).toEqual([...ids].sort());
    });

    it('Del removes a collection with its members from the view; a deleted instance leaves its collection', () => {
        const { g, view, ids } = setup();
        const id = run(g, meta, { kind: 'collect', view, ids: ids.slice(0, 2) }) as string;
        run(g, meta, { kind: 'delete', ids: [ids[0]] });
        expect(boxes(doc(g).views[view], 'collection')[0].members).toEqual([ids[1]]);
        run(g, meta, { kind: 'removeFromView', view, ids: [id] });
        const v = doc(g).views[view];
        expect(boxes(v, 'collection')).toEqual([]);
        expect(boxes(v, 'card').map(n => n.element)).toEqual([ids[2]]);
        expect(Object.keys(doc(g).instances)).toHaveLength(2);
    });

    it('copy takes the members as cards; cut removes the collection and its members', () => {
        const { g, view, ids } = setup();
        const id = run(g, meta, { kind: 'collect', view, ids: ids.slice(0, 2) }) as string;
        expect(copyFromView(doc(g), view, [id])!.boxes.filter(b => b.kind === 'card')).toHaveLength(2);
        run(g, meta, { kind: 'cutFromView', view, ids: [id] });
        const v = doc(g).views[view];
        expect(boxes(v, 'collection')).toEqual([]);
        expect(boxes(v, 'card').map(n => n.element)).toEqual([ids[2]]);
    });

    it('adds an instance to a collection as one undo step; a member has no placement of its own', () => {
        const { g, view, ids } = setup();
        const id = run(g, meta, { kind: 'collect', view, ids: ids.slice(0, 2) }) as string;
        run(g, meta, { kind: 'removeFromView', view, ids: [ids[2]] });
        const { result, patch } = g.transact(x => executeCommand(x, meta, { kind: 'addToCollection', view, id, ids: [ids[2]] }));
        expect(result.ok).toBe(true);
        const v = doc(g).views[view];
        expect(boxes(v, 'collection')[0].members).toEqual([...ids].sort());
        expect(boxes(v, 'card')).toEqual([]);
        g.undo(patch);
        expect(boxes(doc(g).views[view], 'collection')[0].members).not.toContain(ids[2]);
    });

    it('moves a card without a view node (a concept of two containers): the view gets a node at that place', () => {
        const { g, view, ids } = setup();
        run(g, meta, { kind: 'removeFromView', view, ids: [ids[2]] });
        run(g, meta, { kind: 'setBounds', view, bounds: [{ id: ids[2], x: 700, y: 50 }] });
        expect(cardOf(doc(g).views[view], ids[2])).toMatchObject({ x: 700, y: 50 });
    });
});
