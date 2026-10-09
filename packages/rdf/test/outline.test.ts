import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box, Classes, Doc, OutlineNode, View, ViewCard, ViewGroup, boxes, groupOf, isHidden, placementOfId, predicateName, relationsInView } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';

let dir: string, store: ModelStore;
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-outline-'));
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
});
afterEach(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

/** The tree that the Outline computed from the read model before ADR 0007 step 4 (outline.ts `build`), without selection. */
function fromReadModel(doc: Doc, meta: Classes, view: View): OutlineNode[] {
    const node = (kind: OutlineNode['kind'], key: string, name: string, element: string, parent?: OutlineNode): OutlineNode => {
        const n: OutlineNode = { kind, key, name, element, selected: false, children: [] };
        parent?.children.push(n);
        return n;
    };
    const byLabel = <T>(label: (x: T) => string) => (a: T, b: T) => label(a).localeCompare(label(b));
    const cardLabel = (n: ViewCard) => doc.instances[n.element]?.label ?? n.element;
    const relations = relationsInView(doc, view).filter(r => !isHidden(view, r.id));
    const card = (n: ViewCard, parent?: OutlineNode): OutlineNode => {
        const c = node('card', n.id, cardLabel(n), n.id, parent);
        for (const r of relations.filter(x => x.subject === n.element)) node('out', r.id, `${predicateName(meta, r.predicate)} → ${doc.instances[r.object]?.label}`, placementOfId(view, r.id), c);
        for (const r of relations.filter(x => x.object === n.element)) node('in', r.id, `${predicateName(meta, r.predicate)} ← ${doc.instances[r.subject]?.label}`, placementOfId(view, r.id), c);
        return c;
    };
    const parentOf = (box: Box, id: string) => groupOf(view, box, id)?.id;
    const group = (g: ViewGroup, parent?: OutlineNode): OutlineNode => {
        const gn = node('group', g.id, g.label || '(group)', g.id, parent);
        boxes(view, 'group').filter(x => parentOf(x, x.id) === g.id).sort(byLabel<ViewGroup>(x => x.label)).forEach(x => group(x, gn));
        boxes(view, 'card').filter(n => parentOf(n, n.id) === g.id).sort(byLabel(cardLabel)).forEach(n => card(n, gn));
        return gn;
    };
    return [
        ...boxes(view, 'group').filter(g => !parentOf(g, g.id)).sort(byLabel<ViewGroup>(x => x.label)).map(g => group(g)),
        ...boxes(view, 'card').filter(n => !parentOf(n, n.id)).sort(byLabel(cardLabel)).map(n => card(n))
    ];
}

const count = (nodes: OutlineNode[], kind: OutlineNode['kind']): number => nodes.reduce((n, x) => n + (x.kind === kind ? 1 : 0) + count(x.children, kind), 0);
const flat = (nodes: OutlineNode[]): OutlineNode[] => nodes.flatMap(n => [n, ...flat(n.children)]);
const sameAsReadModel = () => {
    const doc = docOf(store);
    for (const view of Object.values(doc.views)) expect(store.outline(view.id)).toEqual(fromReadModel(doc, store.meta, view));
};

describe('Outline by SPARQL on the view graph (ADR 0007 step 4)', () => {
    it('equals the tree of the read model on the fixture views', () => {
        const views = Object.values(docOf(store).views);
        expect(views.length).toBeGreaterThan(0);
        sameAsReadModel();
        const tree = store.outline(views[0].id);
        // The fixture view has frames, cards and placed relations.
        expect([count(tree, 'group'), count(tree, 'card'), count(tree, 'out'), count(tree, 'in')]).toEqual([
            boxes(views[0], 'group').length, boxes(views[0], 'card').length,
            relationsInView(docOf(store), views[0]).filter(r => !isHidden(views[0], r.id)).length,
            relationsInView(docOf(store), views[0]).filter(r => !isHidden(views[0], r.id)).length
        ]);
        expect(count(tree, 'group')).toBeGreaterThan(0);
        expect(count(tree, 'out')).toBeGreaterThan(0);
        expect(store.outline('urn:x:no-view')).toEqual([]);
    });

    it('nested group, moved card, hidden relation: still the tree of the read model', () => {
        const view = Object.values(docOf(store).views)[0];
        const outer = boxes(view, 'group')[0];
        // A group inside the first group; a card into it; one placed relation hidden.
        const created = store.execute({ kind: 'createGroup', view: view.id, label: 'Inner', rect: { x: outer.x + 10, y: outer.y + 10, width: 200, height: 120 } });
        expect(created.ok).toBe(true);
        const card = boxes(view, 'card')[0];
        expect(store.execute({ kind: 'setBounds', view: view.id, bounds: [{ id: card.id, x: outer.x + 20, y: outer.y + 20, width: 100, height: 60 }] }).ok).toBe(true);
        const placed = docOf(store).views[view.id].edges.find(e => e.id)!;
        expect(store.execute({ kind: 'hideEdges', view: view.id, ids: [placed.relation], hidden: true }).ok).toBe(true);
        sameAsReadModel();
        const inner = flat(store.outline(view.id)).find(n => n.name === 'Inner')!;
        expect(inner.kind).toBe('group');
        expect(inner.children.map(c => c.key)).toEqual([card.id]);
        expect(flat(store.outline(view.id)).some(n => n.key === placed.relation)).toBe(false);
    });

    it('selection: a placement or an element in the view, an element of a listing; a group only in its view', () => {
        const view = Object.values(docOf(store).views)[0];
        const card = boxes(view, 'card')[0];
        const edge = view.edges.find(e => e.id)!;
        const group = boxes(view, 'group')[0];
        const selected = (selection: { view?: string; ids: string[] }) => flat(store.outline(view.id, selection)).filter(n => n.selected).map(n => n.element);
        expect(selected({ view: view.id, ids: [card.id] })).toEqual([card.id]);
        expect(selected({ view: view.id, ids: [card.element] })).toEqual([card.id]);
        // A placed edge: its two rows (out of the subject, into the object).
        expect(selected({ view: view.id, ids: [edge.id!] })).toEqual([edge.id, edge.id]);
        expect(selected({ ids: [edge.relation] })).toEqual([edge.id, edge.id]);
        expect(selected({ ids: [card.element] })).toEqual([card.id]);
        expect(selected({ view: view.id, ids: [group.id] })).toEqual([group.id]);
        expect(selected({ ids: [group.id] })).toEqual([]);
    });

    it('selection made in another view: its placements give their elements', () => {
        const view = Object.values(docOf(store).views)[0];
        const card = boxes(view, 'card')[0];
        const created = store.execute({ kind: 'createView', label: 'Other' });
        expect(created.ok).toBe(true);
        const other = Object.values(docOf(store).views).find(v => v.label === 'Other')!;
        expect(store.execute({ kind: 'addToView', view: other.id, ids: [card.element], at: { x: 0, y: 0 } }).ok).toBe(true);
        const otherCard = boxes(docOf(store).views[other.id], 'card')[0];
        expect(otherCard.element).toBe(card.element);
        const selected = flat(store.outline(view.id, { view: other.id, ids: [otherCard.id] })).filter(n => n.selected).map(n => n.element);
        expect(selected).toEqual([card.id]);
        sameAsReadModel();
    });
});
