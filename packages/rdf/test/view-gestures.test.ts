import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    Doc, EdgeLayout, View, arrowProblem, boxOf, boxShowing, boxes, broaderProblem, cardOf, conceptParents, edgeLayout, elementLabel, freeRelations, isHidden,
    isValueSetMember, placementOfId, predicateName, propertyTargetProblem, reconnectProblem, relationLabel, relationsInView, viewsShowing
} from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
let dir: string, store: ModelStore;
afterEach(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

async function open(dcat: boolean): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'catenary-view-gestures-'));
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

/** The candidate ids that a canvas sends: the card elements of what the view shows, the box ids, and '' (no id). */
const cardsOf = (doc: Doc, v: View) => [...new Set(boxes(v, 'card').map(n => n.element)), ''];
const boxesOf = (v: View) => [...v.boxes.map(b => b.kind === 'card' ? b.element : b.id), ''];
const expected = (ids: string[], problem: (id: string) => string | undefined) => Object.fromEntries(ids.map(id => [id, problem(id) ?? '']));

describe('view editor gestures from the backend (ADR 0007 step 5)', () => {
    it('instance views: link, reconnect, arrow problems and facts = the rules on the read model', async () => {
        await open(false);
        const doc = docOf(store), meta = store.meta;
        const v = Object.values(doc.views)[0];
        const note = store.execute({ kind: 'createNote', view: v.id, text: 'N', at: { x: 0, y: 0 } });
        expect(note.ok).toBe(true);
        const d = docOf(store), view = d.views[v.id];
        const cards = cardsOf(d, view), all = boxesOf(view);
        const [a] = boxes(view, 'card');
        const r = Object.values(d.relations).find(x => relationsInView(d, view).includes(x))!;
        const link = store.viewGesture(v.id, { kind: 'link', source: a.element, cards, boxes: all });
        expect(link.problems.cards).toEqual(expected(cards, c => {
            const s = d.instances[a.element], t = d.instances[c];
            if (!s || !t) return 'A relation connects two instances.';
            const free = freeRelations(meta, d, s, t);
            return 'error' in free ? free.error : undefined;
        }));
        expect(link.problems.boxes).toEqual(expected(all, to => to ? arrowProblem(view, a.element, to) : 'An arrow connects two elements of the view.'));
        expect(Object.values(link.problems.cards!).filter(p => p === '').length).toBeGreaterThan(0);
        expect(link.box).toEqual(cardOf(view, a.element));
        const linkIn = store.viewGesture(v.id, { kind: 'linkIn', source: a.element, cards, boxes: all });
        expect(linkIn.problems.cards).toEqual(expected(cards, c => {
            const o = d.instances[a.element], s = d.instances[c];
            if (!o || !s) return 'A relation connects two instances.';
            const free = freeRelations(meta, d, s, o);
            return 'error' in free ? free.error : undefined;
        }));
        expect(linkIn.problems.boxes).toEqual(link.problems.boxes);
        for (const end of ['source', 'target'] as const) {
            expect(store.viewGesture(v.id, { kind: 'reconnect', relation: r.id, end, cards }).problems.cards).toEqual(expected(cards, c => reconnectProblem(meta, d, r, end, c)));
        }
        const n = (note as { id: string }).id;
        expect(store.viewGesture(v.id, { kind: 'arrow', source: n, boxes: all }).problems.boxes).toEqual(expected(all, to => to ? arrowProblem(view, n, to) : 'An arrow connects two elements of the view.'));
        expect(store.viewGesture(v.id, { kind: 'element', id: n }).box).toEqual(boxOf(view, n));
    });

    it('shapes view: property targets, rows, logic, broader, facts = the rules on the read model', async () => {
        await open(true);
        const d = docOf(store), meta = store.meta, { shapes } = d;
        const view = Object.values(d.views).find(x => boxes(x, 'card').some(n => shapes.nodeShapes[n.element]))!;
        const cards = cardsOf(d, view);
        const shape = boxes(view, 'card').find(n => shapes.nodeShapes[n.element])!.element;
        const p = shapes.properties[shapes.nodeShapes[shape].properties[0]];
        expect(store.viewGesture(view.id, { kind: 'shapeLink', source: shape, cards, boxes: [] }).problems.cards).toEqual(expected(cards, c => propertyTargetProblem(shapes, c)));
        expect(store.viewGesture(view.id, { kind: 'shapeLinkIn', source: shape, cards, boxes: [] }).problems.cards)
            .toEqual(expected(cards, c => shapes.nodeShapes[c] ? undefined : 'Only a node shape has properties: drag to a node shape.'));
        expect(store.viewGesture(view.id, { kind: 'target', property: p.id, cards }).problems.cards).toEqual(expected(cards, c => propertyTargetProblem(shapes, c, [p.range])));
        expect(store.viewGesture(view.id, { kind: 'reconnect', relation: p.id, end: 'target', cards }).problems.cards).toEqual(expected(cards, c => propertyTargetProblem(shapes, c, [p.range])));
        expect(store.viewGesture(view.id, { kind: 'row', row: p.id, cards }).problems.cards)
            .toEqual(expected(cards, c => propertyTargetProblem(shapes, c) ?? (c === p.owner ? 'The property is a row of this card.' : undefined)));
        const ids = [...Object.keys(shapes.properties), ...Object.keys(shapes.constraints), ''];
        const logic = store.viewGesture(view.id, { kind: 'logic', from: p.id, ids }).problems.ids!;
        expect(logic[p.id]).toBe('Drag to another property.');
        expect(logic['']).toBe('Drag to another property.');
        expect(Object.keys(logic)).toEqual(ids);
        const concepts = Object.values(shapes.valueSets).flatMap(s => s.members.map(m => m.uri));
        expect(concepts.length).toBeGreaterThan(0);
        const parents = conceptParents(shapes, meta.concepts);
        expect(store.viewGesture(view.id, { kind: 'broader', uri: concepts[0], concepts }).problems.concepts)
            .toEqual(expected(concepts, u => broaderProblem(concepts[0], u, x => isValueSetMember(shapes, x), parents)));
        const facts = store.viewGesture(view.id, { kind: 'element', id: p.id });
        expect(facts.property).toEqual(p);
        expect(facts.ownerBox).toMatchObject({ x: cardOf(view, p.owner)!.x, y: cardOf(view, p.owner)!.y });
        expect(store.viewGesture(view.id, { kind: 'element', id: shape }).nodeShape).toEqual(shapes.nodeShapes[shape]);
        expect(store.viewLabels()).toEqual(Object.fromEntries(Object.values(d.views).map(x => [x.id, x.label])));
    });

    it('Appearance data, occurrences, showing and view labels = the read model', async () => {
        await open(false);
        const v = Object.values(docOf(store).views)[0];
        const r = relationsInView(docOf(store), v)[0];
        expect(store.execute({ kind: 'hideEdges', view: v.id, ids: [r.id], hidden: true }).ok).toBe(true);
        expect(store.execute({ kind: 'createView', label: 'Second' }).ok).toBe(true);
        const d = docOf(store), meta = store.meta, view = d.views[v.id];
        const ids = [...boxes(view, 'card').map(n => n.element), ...boxes(view, 'group').map(g => g.id), r.id];
        const data = store.appearance(v.id, ids)!;
        expect(data.view).toEqual(view);
        expect(data.labels).toEqual(Object.fromEntries(ids.map(id => [id, elementLabel(d, meta, id, view) ?? ''])));
        expect(data.relations[r.id]).toEqual({ name: predicateName(meta, r.predicate), inView: true, layout: edgeLayout(view, r.id) ?? { relation: r.id } as EdgeLayout });
        expect(data.hidden).toEqual(relationsInView(d, view).filter(x => isHidden(view, x.id)).map(x => ({ id: x.id, label: relationLabel(d, meta, x.id) })));
        expect(data.hidden.length).toBe(1);
        expect(store.appearance('urn:x:none', [])).toBeUndefined();

        const card = boxes(view, 'card')[0];
        const views = (id: string) => viewsShowing(d, id).map(x => ({ id: x.id, label: x.label, box: boxShowing(d, x, id) ?? placementOfId(x, id) }));
        expect(store.occurrence([card.id], v.id)).toEqual({ id: card.element, isView: false, label: d.instances[card.element].label, views: views(card.element) });
        expect(store.occurrence([card.element])?.views.length).toBe(1);
        expect(store.occurrence([card.id, boxes(view, 'group')[0].id], v.id)).toBeUndefined();
        expect(store.occurrence([card.id, boxes(view, 'card')[1].id], v.id)).toBeUndefined();
        expect(store.showing(card.element)).toEqual({ id: card.element, isView: false, views: views(card.element) });
        expect(store.showing(v.id).isView).toBe(true);
        expect(store.viewLabels()).toEqual(Object.fromEntries(Object.values(d.views).map(x => [x.id, x.label])));
        expect(Object.keys(store.viewLabels()).length).toBe(2);
    });
});
