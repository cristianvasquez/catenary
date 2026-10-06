import { describe, expect, it } from 'vitest';
import { relationsInView, unnamedLabel, boxes } from '@catenary/model';
import * as ops from '../src/ops';
import { byLabel, doc, example, meta, run, value } from './helpers';

const USES = 'osg://vocab/data-product-draft#uses';

describe('showRelations (drop of a relation on a view)', () => {
    it('adds the subject and the object that are not in the view, subject left of object', async () => {
        const m = await meta();
        const g = await example();
        const a = byLabel(g, 'Agent / chatbot'), q = byLabel(g, 'Reports - CSV');
        const rid = value(ops.createRelation(g, m, a, USES, q));
        const b = value(ops.createView(g, 'B'));

        run(g, m, { kind: 'showRelations', view: b, ids: [rid], at: { x: 0, y: 0 } });
        const v = doc(g).views[b];
        const na = boxes(v, 'card').find(n => n.element === a)!, nq = boxes(v, 'card').find(n => n.element === q)!;
        expect(boxes(v, 'card')).toHaveLength(2);
        expect(na.x).toBeLessThan(nq.x);
        expect(relationsInView(doc(g), v).map(x => x.id)).toEqual([rid]);
    });

    it('with one end in the view, adds the other end only; a hidden edge shows again', async () => {
        const m = await meta();
        const g = await example();
        const a = byLabel(g, 'Agent / chatbot'), q = byLabel(g, 'Reports - CSV');
        const rid = value(ops.createRelation(g, m, a, USES, q));
        const b = value(ops.createView(g, 'B'));
        ops.addToView(g, b, a, { x: 0, y: 0 });

        run(g, m, { kind: 'showRelations', view: b, ids: [rid], at: { x: 500, y: 0 } });
        expect(boxes(doc(g).views[b], 'card').map(n => n.element).sort()).toEqual([a, q].sort());

        ops.hideEdge(g, b, rid, true);
        run(g, m, { kind: 'showRelations', view: b, ids: [rid], at: { x: 0, y: 0 } });
        expect(boxes(doc(g).views[b], 'card')).toHaveLength(2);
        expect(doc(g).views[b].edges).toEqual([{ id: expect.any(String), relation: rid }]);
        expect(relationsInView(doc(g), doc(g).views[b]).map(x => x.id)).toEqual([rid]);
    });
});

describe('unnamedLabel', () => {
    it('counts up past labels in use', () => {
        expect(unnamedLabel('Agent', [])).toBe('unnamed agent 1');
        expect(unnamedLabel('Agent', [{ label: 'unnamed agent 1' }, { label: 'unnamed agent 3' }])).toBe('unnamed agent 2');
    });
});
