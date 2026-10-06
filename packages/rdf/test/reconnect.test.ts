import { describe, expect, it } from 'vitest';
import { edgeLayout, inView } from '@catenary/model';
import { executeCommand } from '../src/commands';
import { ModelGraph } from '../src/graph';
import * as ops from '../src/ops';
import { canonical } from '../src/trig';
import { DPROD, byLabel, doc, example, meta, run, value } from './helpers';

const INPUT_PORT = DPROD + 'inputPort';
const USES = 'osg://vocab/data-product-draft#uses';

function relation(g: ModelGraph, subject: string, predicate: string, object: string): string | undefined {
    return Object.values(doc(g).relations).find(r => r.subject === byLabel(g, subject) && r.predicate === predicate && r.object === byLabel(g, object))?.id;
}

/** The example, with "Query service" and "Analysis / dashboards" in the view "Product context". */
async function setup() {
    const g = await example();
    const ctx = byLabel(g, 'Product context');
    for (const label of ['Query service', 'Analysis / dashboards']) {
        if (!inView(doc(g).views[ctx], byLabel(g, label))) ops.addToView(g, ctx, byLabel(g, label), { x: 0, y: 1000 });
    }
    return { g, ctx, m: await meta() };
}

describe('reconnect a relation', () => {
    it('moves the target: new relation id, the layout stays without the side of the moved end', async () => {
        const { g, ctx, m } = await setup();
        const old = relation(g, 'Product usage data', INPUT_PORT, 'Events API')!;
        const before = edgeLayout(doc(g).views[ctx], old)!;
        expect(before.toSide).toBe('right');

        const id = run(g, m, { kind: 'reconnectRelation', relation: old, end: 'target', to: byLabel(g, 'Query service') });
        expect(id).toBe(relation(g, 'Product usage data', INPUT_PORT, 'Query service'));
        expect(doc(g).relations[old]).toBeUndefined();
        const after = edgeLayout(doc(g).views[ctx], id as string)!;
        expect(after).toMatchObject({ color: before.color, fromSide: before.fromSide });
        expect(after.toSide).toBeUndefined();
    });

    it('moves the source and pins the side of the moved end in the view', async () => {
        const { g, ctx, m } = await setup();
        const old = relation(g, 'Agent / chatbot', USES, 'Query service')!;
        const id = run(g, m, { kind: 'reconnectRelation', relation: old, end: 'source', to: byLabel(g, 'Analysis / dashboards'), view: ctx, side: 'bottom' });
        expect(id).toBe(relation(g, 'Analysis / dashboards', USES, 'Query service'));
        expect(edgeLayout(doc(g).views[ctx], id as string)).toMatchObject({ fromSide: 'bottom', toSide: 'right', color: '6' });
    });

    it('removes the layout in a view that does not show the new end', async () => {
        const { g, ctx, m } = await setup();
        const second = value(ops.duplicateView(g, ctx));
        ops.removeViewElements(g, second, [byLabel(g, 'Query service')]);
        const old = relation(g, 'Product usage data', INPUT_PORT, 'Events API')!;
        expect(edgeLayout(doc(g).views[second], old)).toBeDefined();
        const id = run(g, m, { kind: 'reconnectRelation', relation: old, end: 'target', to: byLabel(g, 'Query service') }) as string;
        expect(doc(g).views[second].edges.some(e => e.relation === old || e.relation === id)).toBe(false);
        expect(edgeLayout(doc(g).views[ctx], id)).toBeDefined();
    });

    it('the same end with a side changes only the layout', async () => {
        const { g, ctx, m } = await setup();
        const old = relation(g, 'Product usage data', INPUT_PORT, 'Events API')!;
        const id = run(g, m, { kind: 'reconnectRelation', relation: old, end: 'target', to: byLabel(g, 'Events API'), view: ctx, side: 'top' });
        expect(id).toBe(old);
        expect(edgeLayout(doc(g).views[ctx], old)?.toSide).toBe('top');
    });

    it('refuses a relation that the shapes do not permit, to itself, or that exists already', async () => {
        const { g, m } = await setup();
        const old = relation(g, 'Product usage data', INPUT_PORT, 'Events API')!;
        const before = canonical(g.quads());
        for (const to of ['Data Product Owner', 'Product usage data', 'Metrics API']) {
            const { result } = g.transact(x => executeCommand(x, m, { kind: 'reconnectRelation', relation: old, end: 'target', to: byLabel(g, to) }));
            expect(result.ok, to).toBe(false);
        }
        expect(canonical(g.quads())).toBe(before);
    });

    it('is one undo step', async () => {
        const { g, ctx, m } = await setup();
        const before = canonical(g.quads());
        const old = relation(g, 'Product usage data', INPUT_PORT, 'Events API')!;
        const { result, patch } = g.transact(x => executeCommand(x, m, {
            kind: 'reconnectRelation', relation: old, end: 'target', to: byLabel(g, 'Query service'), view: ctx, side: 'left'
        }));
        expect(result.ok).toBe(true);
        g.undo(patch);
        expect(canonical(g.quads())).toBe(before);
    });
});
