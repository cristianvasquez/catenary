import { describe, expect, it } from 'vitest';
import { boxes } from '@catenary/model';
import { executeCommand } from '../src/commands';
import * as ops from '../src/ops';
import { byLabel, doc, example, meta, run, value } from './helpers';

const USES = 'osg://vocab/data-product-draft#uses';

// spec/ui-manifest.hs §2: a placement of a relation is stored; placing an element places its relations to the elements on the view.
describe('placements of relations', () => {
    it('placing a card places its relations to the cards of the view; one undo step removes both', async () => {
        const m = await meta();
        const g = await example();
        const a = byLabel(g, 'Agent / chatbot'), q = byLabel(g, 'Reports - CSV');
        const rid = run(g, m, { kind: 'createRelation', subject: a, predicate: USES, object: q }) as string;
        const b = value(ops.createView(g, 'B'));
        run(g, m, { kind: 'addToView', view: b, ids: [a], at: { x: 0, y: 0 } });
        expect(doc(g).views[b].edges).toEqual([]);

        const { result, patch } = g.transact(g => executeCommand(g, m, { kind: 'addToView', view: b, ids: [q], at: { x: 500, y: 0 } }));
        expect(result.ok).toBe(true);
        expect(doc(g).views[b].edges).toEqual([{ id: expect.any(String), relation: rid }]);
        g.undo(patch);
        expect(boxes(doc(g).views[b], 'card').map(c => c.element)).toEqual([a]);
        expect(g.match(null, null, null, ops.viewTerm(g, b)).filter(t => t.predicate.value.endsWith('#reifies'))).toEqual([]);
    });

    it('a removed placement stays removed when other cards are placed', async () => {
        const m = await meta();
        const g = await example();
        const a = byLabel(g, 'Agent / chatbot'), q = byLabel(g, 'Reports - CSV'), x = byLabel(g, 'Product events dataset');
        const rid = run(g, m, { kind: 'createRelation', subject: a, predicate: USES, object: q }) as string;
        const b = value(ops.createView(g, 'B'));
        run(g, m, { kind: 'addToView', view: b, ids: [a, q], at: { x: 0, y: 0 } });
        run(g, m, { kind: 'hideEdges', view: b, ids: [rid], hidden: true });
        run(g, m, { kind: 'addToView', view: b, ids: [x], at: { x: 0, y: 400 } });
        expect(doc(g).views[b].edges.find(e => e.relation === rid)).toEqual({ relation: rid, hidden: true });
    });

    it('a relation made in the form is placed in every view that places both ends', async () => {
        const m = await meta();
        const g = await example();
        const a = byLabel(g, 'Agent / chatbot'), q = byLabel(g, 'Reports - CSV');
        const ctx = byLabel(g, 'Product context');
        const b = value(ops.createView(g, 'B'));
        run(g, m, { kind: 'addToView', view: b, ids: [a, q], at: { x: 0, y: 0 } });
        run(g, m, { kind: 'setStatements', id: a, values: { [USES]: [{ termType: 'NamedNode', value: doc(g).instances[q].uri }] } });
        const rid = Object.values(doc(g).relations).find(r => r.subject === a && r.predicate === USES && r.object === q)!.id;
        expect(doc(g).views[b].edges).toEqual([{ id: expect.any(String), relation: rid }]);
        expect(doc(g).views[ctx].edges.find(e => e.relation === rid)).toEqual({ id: expect.any(String), relation: rid });
    });
});
