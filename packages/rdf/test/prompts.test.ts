import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boxes, hiddenNeighbors, isHidden, relationsInView, unnamedLabel } from '@catenary/model';
import { hiddenNeighborCounts } from '../../model/test/doc-reference';
import { ModelStore } from '../src/model-store';
import { elementId } from '../src/ids';
import { rdf } from '../src/terms';
import { S } from '../src/shapes-read';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';

// The queries that replace the read model of the frontend (ADR 0007): the selection, the boxes of a view, the content of the
// dialogs and pickers of the user actions, labels of new elements.

let dir: string, store: ModelStore;
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-prompts-'));
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

/** A view with an instance card, the card and its instance. */
function cardView() {
    const view = Object.values(docOf(store).views).find(v => boxes(v, 'card').some(c => docOf(store).instances[c.element]))!;
    const card = boxes(view, 'card').find(c => docOf(store).instances[c.element])!;
    return { view, card, instance: card.element };
}

describe('selected: the selection resolved on the read model', () => {
    it('a canvas selection holds placements: their elements, by kind; unknown ids and views go', () => {
        const { view, card, instance } = cardView();
        expect(store.reads.selected({ view: view.id, ids: [card.id, 'no-such-id'] })).toMatchObject({
            view: view.id, ids: [card.id], elements: [instance], instances: [instance], relations: []
        });
        expect(store.reads.selected({ view: 'no-such-view', ids: [instance] })).toMatchObject({ view: undefined, ids: [instance], instances: [instance] });
        expect(store.reads.selected({ ids: [view.id] })).toMatchObject({ views: [view.id] });
    });

    it('nothing when no model is open', () => {
        expect(new ModelStore().reads.selected({ ids: ['x'] }).ids).toEqual([]);
    });
});

describe('view, properties of a view, display cards', () => {
    it('view: the stored view with its placements, from its view graph', () => {
        const { view } = cardView();
        const stored = store.reads.view(view.id)!;
        expect(stored.label).toBe(view.label);
        expect(boxes(stored, 'card').map(c => c.id).sort()).toEqual(boxes(view, 'card').map(c => c.id).sort());
        expect(store.reads.view('no-such-view')).toBeUndefined();
    });

    it('properties of a view: what it holds', () => {
        const { view } = cardView();
        const rels = relationsInView(docOf(store), view);
        const shapes = boxes(view, 'card').filter(c => docOf(store).shapes.nodeShapes[c.element]).length;
        expect(store.reads.properties(view.id)).toEqual({
            kind: 'view', description: '', id: view.id, uri: view.uri, label: view.label, cards: boxes(view, 'card').length - shapes, shapes,
            notes: boxes(view, 'note').length, references: boxes(view, 'reference').length, relations: rels.length,
            hidden: rels.filter(r => isHidden(view, r.id)).length
        });
    });

    it('selection actions carry the cards that Show Details acts on (a canvas selection only)', () => {
        const { view, card, instance } = cardView();
        expect(store.reads.selectionActions({ view: view.id, ids: [card.id] }).cards.map(c => c.element)).toEqual([instance]);
        expect(store.reads.selectionActions({ ids: [instance] }).cards).toEqual([]);
    });
});

describe('dialogs and pickers of the user actions', () => {
    it('deletePlan: one line for each element, notes for implied relations; nothing for unknown ids', () => {
        const { instance } = cardView();
        const plan = store.reads.deletePlan([instance]);
        expect(plan.lines).toHaveLength(1);
        expect(plan.lines[0]).toContain(docOf(store).instances[instance].label);
        const implied = Object.values(docOf(store).relations).filter(r => r.subject === instance || r.object === instance).length;
        expect(plan.notes.some(n => n.startsWith(`Also ${implied} relation`))).toBe(implied > 0);
        expect(store.reads.deletePlan(['no-such-id'])).toEqual({ lines: [], notes: [] });
    });

    it('relationChoices: no relation to itself; undefined when an end is not an instance', () => {
        const { instance } = cardView();
        expect(store.reads.relationChoices(instance, instance)).toEqual({ error: 'A relation from an element to itself is not supported.' });
        expect(store.reads.relationChoices(instance, 'no-such-id')).toBeUndefined();
        const r = Object.values(docOf(store).relations)[0];
        // The relation exists: that type is not offered again.
        const choices = store.reads.relationChoices(r.subject, r.object)!;
        if ('types' in choices) expect(choices.types.map(t => t.path)).not.toContain(r.predicate);
    });

    it('neighborChoices: the hidden neighbors of a card, the same counts as the halo', () => {
        let seen = 0;
        const doc = docOf(store);
        for (const view of Object.values(doc.views)) {
            const counts = hiddenNeighborCounts(doc, view);
            for (const card of boxes(view, 'card').filter(c => doc.instances[c.element])) {
                for (const dir of ['in', 'out'] as const) {
                    const hidden = hiddenNeighbors(doc, view, card.element, dir);
                    seen += hidden.length;
                    expect(counts.get(card.element)?.[dir] ?? 0).toBe(hidden.length);
                    const choices = store.reads.neighborChoices(view.id, card.id, dir);
                    expect(choices?.items.map(i => i.ids) ?? []).toEqual(hidden.map(n => n.relations.map(r => r.id)));
                }
            }
        }
        // The fixture has hidden neighbors: the comparison is not empty.
        expect(seen).toBeGreaterThan(0);
    });

    it('shapeTargetChoices: lists unshown shapes whose target-subject predicate the card has', () => {
        const { view, card, instance } = cardView();
        const g = (store as unknown as { graph: import('../src/graph').ModelGraph }).graph;
        const shape = rdf.namedNode('urn:test:StatusSubjectShape');
        const predicate = rdf.namedNode('urn:test:status');
        const uri = rdf.namedNode(docOf(store).instances[instance].uri);
        const previous = store.hiddenNeighborCounts(view).get(instance)?.targets ?? 0;
        g.add(shape, S.targetSubjectsOf, rdf.namedNode('urn:test:first'), g.shapesGraphs()[0]);
        g.add(shape, S.targetSubjectsOf, predicate, g.shapesGraphs()[0]);
        g.add(uri, predicate, rdf.literal('active'), g.model);

        expect(store.hiddenNeighborCounts(view).get(instance)?.targets).toBe(previous + 1);
        expect(store.reads.shapeTargetChoices(view.id, card.id)).toMatchObject({
            items: expect.arrayContaining([{ ids: [elementId(shape)], label: expect.any(String), description: 'subjects of status' }])
        });
    });

    it('matches subject targets in the home graph of a shapes-file concept', () => {
        const { view } = cardView();
        const g = (store as unknown as { graph: import('../src/graph').ModelGraph }).graph;
        const graph = g.shapesGraphs()[0];
        const concept = rdf.namedNode('urn:test:Concept');
        const shape = rdf.namedNode('urn:test:BroaderSubjects');
        const broader = rdf.namedNode('http://www.w3.org/2004/02/skos/core#broader');
        g.add(concept, S.type, rdf.namedNode('http://www.w3.org/2004/02/skos/core#Concept'), graph);
        g.add(concept, broader, rdf.namedNode('urn:test:Parent'), graph);
        g.add(shape, S.targetSubjectsOf, broader, graph);
        expect(store.execute({ kind: 'addToView', view: view.id, ids: [elementId(concept)], at: { x: 0, y: 0 } })).toMatchObject({ ok: true });
        const current = store.reads.view(view.id)!;
        const card = boxes(current, 'card').find(c => c.element === elementId(concept))!;
        expect(store.hiddenNeighborCounts(current).get(elementId(concept))?.targets).toBe(1);
        expect(store.reads.shapeTargetChoices(view.id, card.id)?.items.map(i => i.ids)).toContainEqual([elementId(shape)]);
    });

    it('linkChoices: a section for each relation type; undefined for an unknown instance', () => {
        const { view, instance } = cardView();
        const out = store.reads.linkChoices('out', instance, view.id);
        expect(out).toBeDefined();
        if (out && 'sections' in out) for (const s of out.sections) expect(s.candidates.map(c => c.id)).not.toContain(instance);
        expect(store.reads.linkChoices('out', 'no-such-id', view.id)).toBeUndefined();
    });

    it('newLabel: the first free "unnamed <kind> N"; a free base label as it is, else the next', () => {
        expect(store.reads.newLabel('view')).toBe(unnamedLabel('view', Object.values(docOf(store).views)));
        expect(store.reads.newLabel('shape')).toBe(unnamedLabel('shape', Object.values(docOf(store).shapes.nodeShapes)));
        const taken = Object.values(docOf(store).views)[0].label;
        expect(store.reads.newLabel('view', { base: 'a free label' })).toBe('a free label');
        expect(store.reads.newLabel('view', { base: taken })).not.toBe(taken);
        const label = store.reads.newLabel('view');
        expect(store.execute({ kind: 'createView', label })).toMatchObject({ ok: true });
        expect(store.reads.newLabel('view')).not.toBe(label);
    });

    it('instancesNamed, unplaced, elementRows', () => {
        const { view, card, instance } = cardView();
        const inst = docOf(store).instances[instance];
        expect(store.reads.instancesNamed(inst.uri)).toEqual([instance]);
        expect(store.reads.unplaced([instance])).toEqual([]);
        expect(store.reads.elementRows([instance, view.id, 'no-such-id'])).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: instance, label: inst.label, kind: 'instance' }),
            expect.objectContaining({ id: view.id, label: view.label, kind: 'view', kindName: 'View' }),
            { id: 'no-such-id', label: undefined, kind: undefined, kindName: '' }
        ]));
        // A placement (a card selected on a canvas) gives the label and kind of its element.
        expect(card.id).not.toBe(instance);
        const [row] = store.reads.elementRows([card.id], view.id);
        expect(row).toMatchObject({ id: card.id, label: inst.label, kind: 'instance' });
        expect(row.kindName).toBe(store.reads.elementRows([instance])[0].kindName);
    });
});

describe('snapshot', () => {
    it('has counts, not the read model and not the report', async () => {
        await store.validate();
        const s = store.snapshot() as unknown as Record<string, unknown>;
        expect(s.doc).toBeUndefined();
        expect(s.violations).toBeUndefined();
        expect(s.counts).toEqual({
            instances: Object.keys(docOf(store).instances).length, results: store.violations.length,
            violations: store.violations.filter(v => v.severity === 'Violation').length
        });
    });
});
