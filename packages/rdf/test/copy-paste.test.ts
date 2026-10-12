import { describe, expect, it } from 'vitest';
import { copyFromView, edgeLayout, iriId, nextLabel, boxes } from '@catenary/model';
import * as ops from '../src/ops';
import { executeCommand } from '../src/commands';
import { canonical } from '../src/trig';
import { DPROD, byLabel, doc, example, load, meta, run, value } from './helpers';

const INPUT_PORT = DPROD + 'inputPort';

const disjoint = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

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

describe('paste (law_pasteNeverMintsIris)', () => {
    it('places the same elements with their dimensions, appearance and edge layouts, packed at the point', async () => {
        const g = await example();
        const m = await meta();
        const ctx = byLabel(g, 'Product context');
        const product = byLabel(g, 'Product usage data'), api = byLabel(g, 'Events API');
        const nodes = boxes(doc(g).views[ctx], 'card').filter(n => n.element === product || n.element === api);
        const relation = Object.values(doc(g).relations).find(r => r.subject === product && r.object === api)!.id;
        const layout = edgeLayout(doc(g).views[ctx], relation)!;
        const instances = Object.keys(doc(g).instances).length;
        const second = value(ops.createView(g, 'Second'));
        const clip = copyFromView(doc(g), ctx, nodes.map(n => n.id))!;
        expect(clip.source).toBe(doc(g).views[ctx].uri);

        const ids = run(g, m, { kind: 'pasteIntoView', view: second, clip, at: { x: 1000, y: 2000 } }) as string[];
        const d = doc(g);
        expect(ids.sort()).toEqual([product, api].sort());
        expect(Object.keys(d.instances)).toHaveLength(instances);
        const pasted = boxes(d.views[second], 'card');
        for (const n of nodes) {
            const p = pasted.find(x => x.element === n.element)!;
            expect([p.width, p.height, p.color, p.display]).toEqual([n.width, n.height, n.color, n.display]);
        }
        expect(disjoint(pasted[0], pasted[1])).toBe(true);
        expect(Math.min(...pasted.map(b => b.x))).toBe(1000);
        expect(Math.min(...pasted.map(b => b.y))).toBe(2000);
        expect(edgeLayout(d.views[second], relation)).toMatchObject({ fromSide: layout.fromSide, toSide: layout.toSide, color: layout.color });
        // The source view does not change.
        expect(boxes(d.views[ctx], 'card').filter(n => n.element === product || n.element === api)).toEqual(nodes);
    });

    it('fails in a view that shows all the elements, and changes nothing', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const clip = copyFromView(doc(g), ctx, boxes(doc(g).views[ctx], 'card').slice(0, 2).map(b => b.id))!;
        const before = canonical(g.quads());
        expect(executeCommand(g, await meta(), { kind: 'pasteIntoView', view: ctx, clip }).ok).toBe(false);
        expect(canonical(g.quads())).toBe(before);
    });

    it('skips elements deleted after the copy', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const [a, b] = boxes(doc(g).views[ctx], 'card').map(x => x.element);
        const second = value(ops.createView(g, 'Second'));
        const clip = copyFromView(doc(g), ctx, [a, b])!;
        ops.deleteInstance(g, a);
        run(g, await meta(), { kind: 'pasteIntoView', view: second, clip });
        expect(boxes(doc(g).views[second], 'card').map(x => x.element)).toEqual([b]);
    });

    it('a copied group brings the cards inside it and is pasted as a new group; an empty group too', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const n = boxes(doc(g).views[ctx], 'card')[0];
        const grp = value(ops.createGroup(g, ctx, 'G', ops.boundsOf(g, ctx, [n.element], 20)!));
        const empty = value(ops.createGroup(g, ctx, 'Empty', { x: -5000, y: -5000, width: 300, height: 200 }));
        const second = value(ops.createView(g, 'Second'));

        const clip = copyFromView(doc(g), ctx, [grp])!;
        expect(clip.boxes.filter(x => x.kind === 'card').map(x => x.element)).toContain(doc(g).instances[n.element].uri);
        run(g, await meta(), { kind: 'pasteIntoView', view: second, clip });
        expect(boxes(doc(g).views[second], 'group').map(x => x.label)).toEqual(['G']);
        expect(boxes(doc(g).views[second], 'card').some(x => x.element === n.element && x.x === n.x && x.y === n.y)).toBe(true);

        run(g, await meta(), { kind: 'pasteIntoView', view: ctx, clip: copyFromView(doc(g), ctx, [empty])! });
        expect(boxes(doc(g).views[ctx], 'group').filter(x => x.label === 'Empty').map(x => [x.width, x.height])).toEqual([[300, 200], [300, 200]]);
    });

    it('a clip refers to elements by IRI: in another model it takes only the same IRIs', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const all = boxes(doc(g).views[ctx], 'card').map(x => x.element);
        // Another model: only one IRI is shared.
        const other = await load(`<urn:name:model> {
            <urn:name:Query%20service> a <http://www.w3.org/ns/dcat#DataService> ; <http://www.w3.org/2000/01/rdf-schema#label> "Query service" .
            <urn:x:1> a <http://ex.org/C> ; <http://www.w3.org/2000/01/rdf-schema#label> "Unrelated" . }
            <urn:v> { <urn:v> a <osg://vocab/view#View> ; <http://www.w3.org/2000/01/rdf-schema#label> "V" . }`);
        const instances = Object.keys(doc(other).instances).length;
        run(other, await meta(), { kind: 'pasteIntoView', view: byLabel(other, 'V'), clip: copyFromView(doc(g), ctx, all)! });
        expect(boxes(doc(other).views[byLabel(other, 'V')], 'card').map(n => doc(other).instances[n.element].label)).toEqual(['Query service']);
        expect(Object.keys(doc(other).instances)).toHaveLength(instances);
    });
});

describe('move (paste of a cut)', () => {
    it('removes the clip from the source and places it in the target, one undo step', async () => {
        const g = await example();
        const m = await meta();
        const ctx = byLabel(g, 'Product context');
        const nodes = boxes(doc(g).views[ctx], 'card').slice(0, 3);
        const elements = nodes.map(n => n.element);
        const instances = Object.keys(doc(g).instances).length;
        const second = value(ops.createView(g, 'Second'));
        const clip = copyFromView(doc(g), ctx, nodes.map(n => n.id), 'cut')!;
        const before = canonical(g.quads());

        const { result, patch } = g.transact(x => executeCommand(x, m, { kind: 'moveBetweenViews', from: clip.source, to: second, clip, at: { x: 1000, y: 2000 } }));
        expect(result.ok).toBe(true);
        const d = doc(g);
        expect(boxes(d.views[ctx], 'card').map(x => x.element).filter(e => elements.includes(e))).toEqual([]);
        expect(boxes(d.views[second], 'card').map(x => x.element).sort()).toEqual([...elements].sort());
        expect(Object.keys(d.instances)).toHaveLength(instances);
        expect(d.views[second].edges).toHaveLength(clip.edges.length);
        g.undo(patch);
        expect(canonical(g.quads())).toBe(before);
    });

    it('within one view re-places the clip at the point', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const [a, b] = boxes(doc(g).views[ctx], 'card').map(x => x.element);
        const clip = copyFromView(doc(g), ctx, [a], 'cut')!;
        run(g, await meta(), { kind: 'moveBetweenViews', from: clip.source, to: ctx, clip, at: { x: 7000, y: 8000 } });
        const cards = boxes(doc(g).views[ctx], 'card');
        expect(cards.filter(x => x.element === a).map(x => [x.x, x.y])).toEqual([[7000, 8000]]);
        expect(cards.some(x => x.element === b)).toBe(true);
    });

    it('moves a note: it leaves the source, a new note shows in the target', async () => {
        const g = await example();
        const ctx = byLabel(g, 'Product context');
        const second = value(ops.createView(g, 'Second'));
        const note = value(ops.createNote(g, ctx, 'n', { x: 0, y: 0 }));
        const clip = copyFromView(doc(g), ctx, [note], 'cut')!;
        run(g, await meta(), { kind: 'moveBetweenViews', from: clip.source, to: second, clip });
        expect(boxes(doc(g).views[ctx], 'note')).toEqual([]);
        expect(boxes(doc(g).views[second], 'note').map(x => x.text)).toEqual(['n']);
    });
});

describe('duplicate (law_duplicateMintsNew)', () => {
    it('mints new instances beside their sources, with the fields, appearance and the relations between the copies', async () => {
        const g = await example();
        const m = await meta();
        const ctx = byLabel(g, 'Product context');
        const product = byLabel(g, 'Product usage data'), api = byLabel(g, 'Events API');
        const sources = boxes(doc(g).views[ctx], 'card').filter(n => n.element === product || n.element === api);
        const layout = edgeLayout(doc(g).views[ctx], Object.values(doc(g).relations).find(r => r.subject === product && r.object === api)!.id)!;
        const before = Object.keys(doc(g).instances);

        const ids = run(g, m, { kind: 'duplicate', view: ctx, ids: sources.map(n => n.id) }) as string[];
        const d = doc(g);
        expect(ids).toHaveLength(2);
        expect(ids.some(id => before.includes(id))).toBe(false);
        const copyOf = (id: string) => ids.find(c => d.instances[c].label === nextLabel(d.instances[id].label, new Set([d.instances[id].label])))!;
        const [mep2, api2] = [copyOf(product), copyOf(api)];
        for (const n of sources) {
            const c = n.element === product ? mep2 : api2;
            expect(d.instances[c].types).toEqual(d.instances[n.element].types);
            expect(d.instances[c].fields).toEqual(d.instances[n.element].fields);
            expect(d.instances[c].uri).not.toBe(d.instances[n.element].uri);
            const p = boxes(d.views[ctx], 'card').find(x => x.element === c)!;
            expect([p.x, p.y, p.width, p.height, p.color, p.display]).toEqual([n.x + 40, n.y + 40, n.width, n.height, n.color, n.display]);
        }
        const copied = Object.values(d.relations).filter(r => ids.includes(r.subject) || ids.includes(r.object));
        expect(copied.map(r => [r.subject, r.predicate, r.object])).toEqual([[mep2, INPUT_PORT, api2]]);
        expect(edgeLayout(d.views[ctx], copied[0].id)).toMatchObject({ fromSide: layout.fromSide, toSide: layout.toSide, color: layout.color });
    });

    it('refuses a node shape and an empty selection, and changes nothing', async () => {
        const g = await load(`<urn:name:model> { <urn:a> a <http://ex.org/C> ; <http://www.w3.org/2000/01/rdf-schema#label> "A" . }
            <urn:shapes:s> { <urn:S> a <http://www.w3.org/ns/shacl#NodeShape> ; <http://www.w3.org/ns/shacl#targetClass> <http://ex.org/C> . }
            <urn:v> { <urn:v> a <osg://vocab/view#View> ; <http://www.w3.org/2000/01/rdf-schema#label> "V" . }`);
        const m = await meta();
        const ctx = byLabel(g, 'V');
        const api = byLabel(g, 'A'), shape = iriId('urn:S');
        run(g, m, { kind: 'addToView', view: ctx, ids: [api], at: { x: 0, y: 0 } });
        run(g, m, { kind: 'addToView', view: ctx, ids: [shape], at: { x: 900, y: 0 } });
        const before = canonical(g.quads());
        const shapeResult = executeCommand(g, m, { kind: 'duplicate', view: ctx, ids: [api, shape] });
        expect(shapeResult).toEqual({ ok: false, error: 'A node shape cannot be duplicated yet.' });
        expect(executeCommand(g, m, { kind: 'duplicate', view: ctx, ids: [] })).toEqual({ ok: false, error: 'Nothing to duplicate.' });
        expect(canonical(g.quads())).toBe(before);
    });
});
