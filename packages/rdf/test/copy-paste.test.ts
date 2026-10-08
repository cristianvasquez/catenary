import { describe, expect, it } from 'vitest';
import { copyFromView, edgeLayout, nextLabel, boxes } from '@catenary/model';
import * as ops from '../src/ops';
import { executeCommand } from '../src/commands';
import { canonical } from '../src/trig';
import { DPROD, byLabel, doc, example, load, meta, run, value } from './helpers';

const INPUT_PORT = DPROD + 'inputPort';

describe('label of a copy', () => {
    it('counts up a trailing number, or appends one', () => {
        expect(nextLabel('Agent 1', new Set(['Agent 1']))).toBe('Agent 2');
        expect(nextLabel('Agent 1', new Set(['Agent 1', 'Agent 2']))).toBe('Agent 3');
        expect(nextLabel('agent-1', new Set())).toBe('agent-2');
        expect(nextLabel('v09', new Set())).toBe('v10');
        expect(nextLabel('Query service', new Set(['Query service']))).toBe('Query service 2');
        expect(nextLabel('Query service', new Set(['Query service 2']))).toBe('Query service 3');
    });
});

describe('copy and paste', () => {
    it('paste of a copy creates new instances with the same types and field values, a new label and a new IRI', async () => {
        const g = await example();
        const m = await meta();
        const ctx = byLabel(g, 'Product context');
        const source = doc(g).instances[byLabel(g, 'Product usage data')];
        const second = value(ops.createView(g, 'Second'));
        const clip = copyFromView(doc(g), ctx, [source.id])!;
        expect(clip.mode).toBe('copy');

        const ids = run(g, m, { kind: 'pasteIntoView', view: second, clip, at: { x: 10, y: 20 } }) as string[];
        expect(ids).toHaveLength(1);
        const copy = doc(g).instances[ids[0]];
        expect(copy.id).not.toBe(source.id);
        expect(copy.label).toBe('Product usage data 2');
        expect(copy.uri).not.toBe(source.uri);
        expect(copy.types).toEqual(source.types);
        expect(copy.fields).toEqual(source.fields);
        // Relations to instances that were not copied are not duplicated.
        expect(Object.values(doc(g).relations).some(r => r.subject === copy.id || r.object === copy.id)).toBe(false);
        expect(boxes(doc(g).views[second], 'card')).toMatchObject([{ element: copy.id, x: 10, y: 20 }]);
    });

    it('duplicates relations and appearance, packs the copies, and leaves existing placements fixed', async () => {
        const g = await example();
        const m = await meta();
        const ctx = byLabel(g, 'Product context');
        const product = byLabel(g, 'Product usage data'), api = byLabel(g, 'Events API');
        const nodes = boxes(doc(g).views[ctx], 'card').filter(n => n.element === product || n.element === api);
        const before = structuredClone(doc(g).views[ctx].boxes);
        const layout = edgeLayout(doc(g).views[ctx], Object.values(doc(g).relations).find(r => r.subject === product && r.object === api)!.id)!;
        const instances = Object.keys(doc(g).instances).length;
        const clip = copyFromView(doc(g), ctx, [product, api])!;

        const ids = run(g, m, { kind: 'pasteIntoView', view: ctx, clip, at: { x: 5000, y: 5000 } }) as string[];
        const d = doc(g);
        expect(Object.keys(d.instances)).toHaveLength(instances + 2);
        const byOrigin = new Map(ids.map(id => [d.instances[id].label.replace(/ 2$/, ''), id]));
        const [mep2, api2] = [byOrigin.get('Product usage data')!, byOrigin.get('Events API')!];
        const copied = Object.values(d.relations).filter(r => ids.includes(r.subject) || ids.includes(r.object));
        expect(copied.map(r => [r.subject, r.predicate, r.object])).toEqual([[mep2, INPUT_PORT, api2]]);
        expect(edgeLayout(d.views[ctx], copied[0].id)).toMatchObject({ fromSide: layout.fromSide, toSide: layout.toSide, color: layout.color });
        for (const n of nodes) {
            const id = n.element === product ? mep2 : api2;
            const p = boxes(d.views[ctx], 'card').find(x => x.element === id)!;
            expect([p.width, p.height, p.color]).toEqual([n.width, n.height, n.color]);
        }
        expect(d.views[ctx].boxes.filter(b => before.some(p => p.id === b.id))).toEqual(before);
        const pasted = boxes(d.views[ctx], 'card').filter(b => ids.includes(b.element));
        expect(Math.min(...pasted.map(b => b.x))).toBe(5000);
        expect(Math.min(...pasted.map(b => b.y))).toBe(5000);
        expect(pasted[0].x + pasted[0].width <= pasted[1].x || pasted[1].x + pasted[1].width <= pasted[0].x
            || pasted[0].y + pasted[0].height <= pasted[1].y || pasted[1].y + pasted[1].height <= pasted[0].y).toBe(true);
    });

    it('each paste of the same copy creates new instances; one undo step each', async () => {
        const g = await example();
        const m = await meta();
        const ctx = byLabel(g, 'Product context');
        const clip = copyFromView(doc(g), ctx, [byLabel(g, 'Events API')])!;
        run(g, m, { kind: 'pasteIntoView', view: ctx, clip });
        const before = canonical(g.quads());
        const { result, patch } = g.transact(x => executeCommand(x, m, { kind: 'pasteIntoView', view: ctx, clip }));
        expect(result.ok).toBe(true);
        expect(Object.values(doc(g).instances).map(i => i.label).filter(l => l.startsWith('Events API')).sort())
            .toEqual(['Events API', 'Events API 2', 'Events API 3']);
        g.undo(patch);
        expect(canonical(g.quads())).toBe(before);
    });

    it('a copied group brings the cards inside it and is pasted as a new group', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const n = boxes(doc(g).views[ctx], 'card')[0];
        const grp = value(ops.createGroup(g, ctx, 'G', ops.boundsOf(g, ctx, [n.element], 20)!));
        const second = value(ops.createView(g, 'Second'));

        const clip = copyFromView(doc(g), ctx, [grp], 'cut')!;
        expect(clip.boxes.filter(x => x.kind === 'card').map(x => x.element)).toContain(doc(g).instances[n.element].uri);
        run(g, await meta(), { kind: 'pasteIntoView', view: second, clip });
        expect(boxes(doc(g).views[second], 'group').map(x => x.label)).toEqual(['G']);
        expect(boxes(doc(g).views[second], 'card').some(x => x.element === n.element && x.x === n.x && x.y === n.y)).toBe(true);
    });

    it('paste of a copy skips instances deleted after the copy', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const [a, b] = boxes(doc(g).views[ctx], 'card').map(x => x.element);
        const label = doc(g).instances[b].label;
        const second = value(ops.createView(g, 'Second'));
        const clip = copyFromView(doc(g), ctx, [a, b])!;
        ops.deleteInstance(g, a);
        run(g, await meta(), { kind: 'pasteIntoView', view: second, clip });
        expect(boxes(doc(g).views[second], 'card').map(x => doc(g).instances[x.element].label)).toEqual([nextLabel(label, new Set([label]))]);
    });
});

describe('cut and paste', () => {
    it('paste of a cut adds the same instances and edge layouts, with packed new placements', async () => {
        const g = await example();
        const m = await meta();
        const ctx = byLabel(g, 'Product context');
        const nodes = boxes(doc(g).views[ctx], 'card').slice(0, 3);
        // A canvas selection: the placements of the cards.
        const ids = nodes.map(n => n.id), elements = nodes.map(n => n.element);
        const instances = Object.keys(doc(g).instances).length;
        const second = value(ops.createView(g, 'Second'));

        const clip = copyFromView(doc(g), ctx, ids, 'cut')!;
        expect(clip.boxes.filter(n => n.kind === 'card').map(n => n.element)).toEqual(elements.map(id => doc(g).instances[id].uri));
        run(g, m, { kind: 'cutFromView', view: ctx, ids });
        run(g, m, { kind: 'pasteIntoView', view: second, clip, at: { x: 1000, y: 2000 } });

        const pasted = boxes(doc(g).views[second], 'card');
        expect(pasted.map(n => n.element)).toEqual(elements);
        expect(Object.keys(doc(g).instances)).toHaveLength(instances);
        pasted.forEach((p, i) => {
            expect([p.width, p.height]).toEqual([nodes[i].width, nodes[i].height]);
            for (const other of pasted) if (other !== p) expect(p.x + p.width <= other.x || other.x + other.width <= p.x
                || p.y + p.height <= other.y || other.y + other.height <= p.y).toBe(true);
        });
        expect(Math.min(...pasted.map(b => b.x))).toBe(1000);
        expect(Math.min(...pasted.map(b => b.y))).toBe(2000);
        expect(doc(g).views[second].edges).toHaveLength(clip.edges.length);
    });

    it('paste of a cut into a view that has all its instances fails', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const clip = copyFromView(doc(g), ctx, [boxes(doc(g).views[ctx], 'card')[0].id], 'cut')!;
        expect(executeCommand(g, await meta(), { kind: 'pasteIntoView', view: ctx, clip }).ok).toBe(false);
    });

    it('cut removes the clip from the source view only (one command)', async () => {
        const g = await example();
        const m = await meta();
        const ctx = byLabel(g, 'Product context');
        const [a, b] = boxes(doc(g).views[ctx], 'card').map(x => x.element);
        run(g, m, { kind: 'cutFromView', view: ctx, ids: [a] });
        expect(boxes(doc(g).views[ctx], 'card').map(x => x.element)).not.toContain(a);
        expect(boxes(doc(g).views[ctx], 'card').map(x => x.element)).toContain(b);
        expect(doc(g).instances[a]).toBeDefined();
    });

    it('paste skips instances deleted after the cut', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const [a, b] = boxes(doc(g).views[ctx], 'card').map(x => x.element);
        const second = value(ops.createView(g, 'Second'));
        const clip = copyFromView(doc(g), ctx, [a, b], 'cut')!;
        ops.deleteInstance(g, a);
        run(g, await meta(), { kind: 'pasteIntoView', view: second, clip });
        expect(boxes(doc(g).views[second], 'card').map(x => x.element)).toEqual([b]);
    });

    it('a clip refers to instances by IRI: in another model it takes only the same IRIs', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const all = boxes(doc(g).views[ctx], 'card').map(x => x.element);
        // Another model: only one IRI is shared.
        const other = await load(`<urn:name:model> {
            <urn:name:Query%20service> a <http://www.w3.org/ns/dcat#DataService> ; <http://www.w3.org/2000/01/rdf-schema#label> "Query service" .
            <urn:x:1> a <http://ex.org/C> ; <http://www.w3.org/2000/01/rdf-schema#label> "Unrelated" . }
            <urn:v> { <urn:v> a <osg://vocab/view#View> ; <http://www.w3.org/2000/01/rdf-schema#label> "V" . }`);
        const m = await meta();
        const labels = () => boxes(doc(other).views[byLabel(other, 'V')], 'card').map(n => doc(other).instances[n.element].label);
        run(other, m, { kind: 'pasteIntoView', view: byLabel(other, 'V'), clip: copyFromView(doc(g), ctx, all, 'cut')! });
        expect(labels()).toEqual(['Query service']);
        run(other, m, { kind: 'pasteIntoView', view: byLabel(other, 'V'), clip: copyFromView(doc(g), ctx, all, 'copy')! });
        expect(labels().sort()).toEqual(['Query service', 'Query service 2']);
    });
});
