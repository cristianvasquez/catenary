import { describe, expect, it } from 'vitest';
import { relationsInView, viewsUsing, boxes, cardOf, inView } from '@catenary/model';
import { unplacedInstances, unplacedRelations } from '../../model/test/doc-reference';
import { executeCommand } from '../src/commands';
import * as ops from '../src/ops';
import { canonical, writeTrig } from '../src/trig';
import { byLabel, doc, example, meta, run, value } from './helpers';

const USES = 'osg://vocab/data-product-draft#uses';

describe('delete semantics', () => {
    it('delete from view removes only the node and its edge layouts in that view', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const id = byLabel(g, 'Product events dataset');
        const second = value(ops.createView(g, 'Second'));
        ops.addToView(g, second, id, { x: 0, y: 0 });
        const relations = Object.keys(doc(g).relations).length;

        ops.removeViewElements(g, ctx, [id]);
        const d = doc(g);
        expect(d.instances[id]).toBeDefined();
        expect(Object.keys(d.relations)).toHaveLength(relations);
        expect(inView(d.views[ctx], id)).toBe(false);
        expect(d.views[ctx].edges.some(e => [d.relations[e.relation].subject, d.relations[e.relation].object].includes(id))).toBe(false);
        expect(viewsUsing(d, id).map(v => v.label)).toEqual(['Second']);
    });

    it('delete from model removes the instance, its triples and all view references', async () => {
        const g = await example();
        const id = byLabel(g, 'Product events dataset');
        const second = value(ops.createView(g, 'Second'));
        ops.addToView(g, second, id, { x: 0, y: 0 });
        expect(viewsUsing(doc(g), id).map(v => v.label)).toEqual(['Product context', 'Second']);

        ops.deleteInstance(g, id);
        const d = doc(g);
        expect(d.instances[id]).toBeUndefined();
        expect(Object.values(d.relations).some(r => r.subject === id || r.object === id)).toBe(false);
        for (const v of Object.values(d.views)) {
            expect(inView(v, id)).toBe(false);
            for (const e of v.edges) expect(d.relations[e.relation]).toBeDefined();
        }
        expect(await writeTrig(g.quads())).not.toContain('Product%20events%20dataset');
    });

    it('edges: a new relation shows in every view with both ends; hide is per view; delete removes it everywhere', async () => {
        const m = await meta();
        const g = await example();
        const a = byLabel(g, 'Agent / chatbot'), q = byLabel(g, 'Reports - CSV');
        const ctx = byLabel(g, 'Product context');
        const b = value(ops.createView(g, 'B'));
        ops.addToView(g, b, a, { x: 0, y: 0 });
        ops.addToView(g, b, q, { x: 500, y: 0 });
        const rid = run(g, m, { kind: 'createRelation', subject: a, predicate: USES, object: q }) as string;
        expect(relationsInView(doc(g), doc(g).views[b]).map(x => x.id)).toContain(rid);
        expect(relationsInView(doc(g), doc(g).views[ctx]).map(x => x.id)).toContain(rid);
        // A new relation is placed in every view that places both ends.
        expect(doc(g).views[b].edges).toEqual([{ id: expect.any(String), relation: rid }]);
        expect(doc(g).views[ctx].edges.find(e => e.relation === rid)).toEqual({ id: expect.any(String), relation: rid });

        // Hide removes the placement in one view; the read model marks the relation hidden there.
        ops.hideEdge(g, b, rid, true);
        expect(doc(g).views[b].edges).toEqual([{ relation: rid, hidden: true }]);
        expect(doc(g).views[ctx].edges.find(e => e.relation === rid)).toEqual({ id: expect.any(String), relation: rid });
        ops.hideEdge(g, b, rid, false);
        expect(doc(g).views[b].edges).toEqual([{ id: expect.any(String), relation: rid }]);

        expect(ops.createRelation(g, m, a, USES, q).ok).toBe(false);
        expect(ops.createRelation(g, m, q, USES, a).ok).toBe(false);
        ops.hideEdge(g, b, rid, true);
        ops.deleteRelation(g, rid);
        expect(doc(g).views[b].edges).toEqual([]);
    });

    it('createRelation with sides pins the edge sides in that view only', async () => {
        const m = await meta();
        const g = await example();
        const a = byLabel(g, 'Agent / chatbot'), q = byLabel(g, 'Reports - CSV');
        const ctx = byLabel(g, 'Product context');
        const b = value(ops.createView(g, 'B'));
        ops.addToView(g, b, a, { x: 0, y: 0 });
        ops.addToView(g, b, q, { x: 500, y: 0 });
        const rid = run(g, m, { kind: 'createRelation', subject: a, predicate: USES, object: q, view: b, sides: { fromSide: 'bottom', toSide: 'left' } });
        expect(doc(g).views[b].edges).toEqual([{ id: expect.any(String), relation: rid, fromSide: 'bottom', toSide: 'left' }]);
        expect(doc(g).views[ctx].edges.find(e => e.relation === rid)).toEqual({ id: expect.any(String), relation: rid });
    });

    it('an unknown id: the error names the id', async () => {
        const m = await meta();
        const g = await example();
        const q = byLabel(g, 'Reports - CSV');
        expect(executeCommand(g, m, { kind: 'createRelation', subject: 'n-nothing', predicate: USES, object: q }))
            .toEqual({ ok: false, error: 'No instance with the id n-nothing: the id is wrong or the instance was deleted.' });
        expect(executeCommand(g, m, { kind: 'addToView', view: byLabel(g, 'Product context'), ids: ['n-nothing'], at: { x: 0, y: 0 } }))
            .toEqual({ ok: false, error: 'No element with the id n-nothing: the id is wrong or the element was deleted.' });
    });

    it('createRelation with a new subject places it in the view at `at`', async () => {
        const m = await meta();
        const g = await example();
        const q = byLabel(g, 'Reports - CSV');
        const agent = doc(g).instances[byLabel(g, 'Agent / chatbot')].types[0];
        const b = value(ops.createView(g, 'B'));
        ops.addToView(g, b, q, { x: 500, y: 0 });
        const rid = run(g, m, { kind: 'createRelation', subject: { classIri: agent, label: 'New agent' }, predicate: USES, object: q, view: b, at: { x: 0, y: 0 } }) as string;
        const r = doc(g).relations[rid];
        expect(r.object).toBe(q);
        expect(doc(g).instances[r.subject].label).toBe('New agent');
        expect(boxes(doc(g).views[b], 'card').map(n => n.element).sort()).toEqual([q, r.subject].sort());
    });

    it('Del in a view: cards leave, edges are hidden, groups are deleted (one command)', async () => {
        const m = await meta();
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const d0 = doc(g).views[ctx];
        // The ids of a canvas selection: placements (a card, an edge, a group).
        const box = boxes(d0, 'card')[0], card = box.element, group = boxes(d0, 'group')[0].id;
        const placed = d0.edges.find(e => !e.hidden && ![doc(g).relations[e.relation].subject, doc(g).relations[e.relation].object].includes(card))!;
        const edge = placed.relation;
        run(g, m, { kind: 'removeFromView', view: ctx, ids: [box.id, placed.id!, group] });
        const v = doc(g).views[ctx];
        expect(inView(v, card)).toBe(false);
        expect(v.edges.find(e => e.relation === edge)?.hidden).toBe(true);
        expect(boxes(v, 'group').some(x => x.id === group)).toBe(false);
    });

    it('delete view does not change the model', async () => {
        const g = await example();
        const before = JSON.stringify([doc(g).instances, doc(g).relations]);
        ops.deleteView(g, byLabel(g, 'Product context'));
        expect(JSON.stringify([doc(g).instances, doc(g).relations])).toBe(before);
    });

    it('not placed: relations with no placed edge (a hidden edge has none), instances with no card', async () => {
        const g = await example();
        const d = doc(g);
        const label = (id: string) => d.instances[id].label;
        const rel = (id: string) => `${label(d.relations[id].subject)} ${label(d.relations[id].object)}`;
        expect(unplacedRelations(d).map(rel).sort()).toEqual(['Product usage data Data Product Owner', 'Product usage data Product Analytics']);
        expect(unplacedInstances(d).map(label).sort()).toEqual(['Data Product Owner', 'Product Analytics']);
        const ctx = byLabel(g, 'Product context');
        const r = Object.values(d.relations).find(x => label(x.subject) === 'Agent / chatbot')!;
        ops.hideEdge(g, ctx, r.id, true);
        expect(unplacedRelations(doc(g))).toContain(r.id);
    });
});

describe('undo', () => {
    it('undo of a patch restores the dataset exactly; redo applies it again', async () => {
        const m = await meta();
        const g = await example();
        const before = canonical(g.quads());
        const id = byLabel(g, 'Product events dataset');
        const { patch } = g.transact(g => {
            ops.deleteInstance(g, id);
            return ops.createView(g, 'X');
        });
        const after = canonical(g.quads());
        g.undo(patch);
        expect(canonical(g.quads())).toBe(before);
        expect(doc(g).instances[id].label).toBe('Product events dataset');
        g.redo(patch);
        expect(canonical(g.quads())).toBe(after);
        expect(m.classes.length).toBeGreaterThan(0);
    });

    it('a failed command leaves no change (rollback)', async () => {
        const g = await example();
        const before = canonical(g.quads());
        const { result, patch } = g.transact(g => {
            ops.createView(g, 'Y');
            return ops.fail('stop');
        });
        expect(result.ok).toBe(false);
        expect(patch).toEqual([]);
        expect(canonical(g.quads())).toBe(before);
        expect(g.transact(g => { ops.createView(g, 'Z'); throw new Error('boom'); }).result).toEqual({ ok: false, error: 'boom' });
        expect(canonical(g.quads())).toBe(before);
    });

    it('commands take the placement of a card: setBounds moves that card, delete deletes its element (M1b)', async () => {
        const m = await meta();
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const card = boxes(doc(g).views[ctx], 'card')[0];
        expect(card.id).not.toBe(card.element);
        run(g, m, { kind: 'setBounds', view: ctx, bounds: [{ id: card.id, x: 4321 }] });
        expect(cardOf(doc(g).views[ctx], card.element)!.x).toBe(4321);
        run(g, m, { kind: 'delete', ids: [card.id] });
        expect(doc(g).instances[card.element]).toBeUndefined();
    });
});

