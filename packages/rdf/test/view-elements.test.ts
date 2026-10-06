import { describe, expect, it } from 'vitest';
import { Doc, copyFromView, viewReferencesTo, boxes, cardOf, placementOfId } from '@catenary/model';
import { V, placementIri } from '../src/graph';
import { elementId } from '../src/ids';
import type { Term } from '@rdfjs/types';
import { executeCommand } from '../src/commands';
import { canonical, writeTrig } from '../src/trig';
import { project } from './project-full';
import { rdf } from '../src/terms';
import { doc, emptyGraph, load, run } from './helpers';

const meta = { classes: [] };
const elementIdOf = (t: Term) => elementId(t as Parameters<typeof elementId>[0]);

describe('view-owned elements', () => {
    it('stores notes and view references in view graphs and keeps them through a TriG round trip', async () => {
        const g = emptyGraph();
        const source = run(g, meta, { kind: 'createView', label: 'Source' }) as string;
        const target = run(g, meta, { kind: 'createView', label: 'Target' }) as string;
        const note = run(g, meta, { kind: 'createNote', view: source, text: 'First line\nSecond line', at: { x: 10, y: 20 } }) as string;
        run(g, meta, { kind: 'setViewElements', view: source, ids: [note], patch: { width: 410, height: 230 } });
        run(g, meta, { kind: 'addViewReference', view: source, target, at: { x: 500, y: 300 } });

        const before = doc(g);
        expect(boxes(before.views[source], 'note')).toMatchObject([{ id: note, text: 'First line\nSecond line', x: 10, y: 20, width: 410, height: 230 }]);
        expect(boxes(before.views[source], 'reference')).toMatchObject([{ target, x: 360, y: 252, width: 280, height: 96 }]);
        expect(viewReferencesTo(before, target)).toHaveLength(1);

        const reopened = await load(await writeTrig(g.quads()));
        const after = doc(reopened);
        const sourceAfter = Object.values(after.views).find(v => v.label === 'Source')!;
        const targetAfter = Object.values(after.views).find(v => v.label === 'Target')!;
        expect(boxes(sourceAfter, 'note')).toMatchObject([{ text: 'First line\nSecond line', x: 10, y: 20, width: 410, height: 230 }]);
        expect(boxes(sourceAfter, 'reference')).toMatchObject([{ target: targetAfter.id, x: 360, y: 252, width: 280, height: 96 }]);
    });

    it('applies Markdown as one undo step and preserves the source through saving', async () => {
        const g = emptyGraph();
        const view = run(g, meta, { kind: 'createView', label: 'Notes' }) as string;
        const id = run(g, meta, { kind: 'createNote', view, text: 'Original', at: { x: 0, y: 0 } }) as string;
        const text = '# Heading\n\n- **Bold** and _italic_\n\n```js\nconst n = 1;\n```\n';
        const { result, patch } = g.transact(x => executeCommand(x, meta, { kind: 'setViewElements', view, ids: [id], expectedText: 'Original', patch: { text } }));
        expect(result.ok).toBe(true);
        expect(boxes(doc(g).views[view], 'note')[0].text).toBe(text);
        g.undo(patch);
        expect(boxes(doc(g).views[view], 'note')[0].text).toBe('Original');
        g.redo(patch);
        expect(boxes(doc(g).views[view], 'note')[0].text).toBe(text);
        const reopened = doc(await load(await writeTrig(g.quads())));
        expect(boxes(Object.values(reopened.views)[0], 'note')[0].text).toBe(text);
    });

    it('rejects stale drafts without changing text, layout, or the undo patch', () => {
        const g = emptyGraph();
        const view = run(g, meta, { kind: 'createView', label: 'Notes' }) as string;
        const id = run(g, meta, { kind: 'createNote', view, text: '', at: { x: 0, y: 0 } }) as string;
        run(g, meta, { kind: 'setViewElements', view, ids: [id], expectedText: '', patch: { text: 'Newer text' } });
        const before = canonical(g.quads());
        const { result, patch } = g.transact(x => executeCommand(x, meta, {
            kind: 'setViewElements', view, ids: [id], expectedText: '', patch: { text: 'Stale draft', width: 900 }
        }));
        expect(result.ok).toBe(false);
        expect(canonical(g.quads())).toBe(before);
        expect(patch).toHaveLength(0);
    });

    it('copies and cuts notes and view references without copying their target view', () => {
        const g = emptyGraph();
        const source = run(g, meta, { kind: 'createView', label: 'Source' }) as string;
        const target = run(g, meta, { kind: 'createView', label: 'Target' }) as string;
        const destination = run(g, meta, { kind: 'createView', label: 'Destination' }) as string;
        const note = run(g, meta, { kind: 'createNote', view: source, text: 'Remember this', at: { x: 10, y: 20 } }) as string;
        const reference = run(g, meta, { kind: 'addViewReference', view: source, target, at: { x: 300, y: 200 } }) as string;

        const copy = copyFromView(doc(g), source, [note, reference])!;
        const pasted = run(g, meta, { kind: 'pasteIntoView', view: destination, clip: copy, at: { x: 1000, y: 1000 } }) as string[];
        expect(pasted).toHaveLength(2);
        expect(boxes(doc(g).views[destination], 'note').map(n => n.text)).toEqual(['Remember this']);
        expect(boxes(doc(g).views[destination], 'reference').map(r => r.target)).toEqual([target]);
        expect(Object.keys(doc(g).views)).toHaveLength(3);

        const cut = copyFromView(doc(g), source, [note, reference], 'cut')!;
        run(g, meta, { kind: 'cutFromView', view: source, ids: [note, reference] });
        expect(boxes(doc(g).views[source], 'note')).toEqual([]);
        expect(boxes(doc(g).views[source], 'reference')).toEqual([]);
        run(g, meta, { kind: 'pasteIntoView', view: destination, clip: cut, at: { x: 1500, y: 1500 } });
        expect(boxes(doc(g).views[destination], 'note')).toHaveLength(2);
        // The destination refers to the target already: the reference of the cut is skipped (a view places another view once).
        expect(boxes(doc(g).views[destination], 'reference')).toHaveLength(1);
    });

    it('colors notes and view references, keeps the color through save, copy and undo', async () => {
        const g = emptyGraph();
        const source = run(g, meta, { kind: 'createView', label: 'Source' }) as string;
        const target = run(g, meta, { kind: 'createView', label: 'Target' }) as string;
        const note = run(g, meta, { kind: 'createNote', view: source, text: 'n', at: { x: 0, y: 0 } }) as string;
        const reference = run(g, meta, { kind: 'addViewReference', view: source, target, at: { x: 500, y: 0 } }) as string;
        const before = canonical(g.quads());

        const { result, patch } = g.transact(x => executeCommand(x, meta, { kind: 'setViewElements', view: source, ids: [note, reference], patch: { color: '4' } }));
        expect(result.ok).toBe(true);
        expect(boxes(doc(g).views[source], 'note')[0].color).toBe('4');
        expect(boxes(doc(g).views[source], 'reference')[0].color).toBe('4');
        g.undo(patch);
        expect(canonical(g.quads())).toBe(before);
        g.redo(patch);

        const reopened = Object.values(doc(await load(await writeTrig(g.quads()))).views).find(v => v.label === 'Source')!;
        expect(boxes(reopened, 'note')[0].color).toBe('4');
        expect(boxes(reopened, 'reference')[0].color).toBe('4');

        run(g, meta, { kind: 'pasteIntoView', view: target, clip: copyFromView(doc(g), source, [note, reference])!, at: { x: 0, y: 0 } });
        expect(boxes(doc(g).views[target], 'note')[0].color).toBe('4');
        expect(boxes(doc(g).views[target], 'reference')[0].color).toBe('4');

        run(g, meta, { kind: 'setViewElements', view: source, ids: [note], patch: { color: '' } });
        expect(boxes(doc(g).views[source], 'note')[0].color).toBeUndefined();
    });

    it('removes notes and view references from a view, and groups around them', () => {
        const g = emptyGraph();
        const source = run(g, meta, { kind: 'createView', label: 'Source' }) as string;
        const target = run(g, meta, { kind: 'createView', label: 'Target' }) as string;
        const note = run(g, meta, { kind: 'createNote', view: source, text: 'n', at: { x: 0, y: 0 } }) as string;
        const reference = run(g, meta, { kind: 'addViewReference', view: source, target, at: { x: 1000, y: 1000 } }) as string;

        run(g, meta, { kind: 'createGroup', view: source, label: 'around', around: [note, reference] });
        const group = boxes(doc(g).views[source], 'group')[0];
        const r = boxes(doc(g).views[source], 'reference')[0];
        expect(group.x).toBeLessThan(0);
        expect(group.x + group.width).toBeGreaterThan(r.x + r.width);

        run(g, meta, { kind: 'removeFromView', view: source, ids: [note, reference, group.id] });
        expect(doc(g).views[source].boxes).toEqual([]);
    });

    it('deletes a target view and all incoming references as one undoable command', () => {
        const g = emptyGraph();
        const source = run(g, meta, { kind: 'createView', label: 'Source' }) as string;
        const other = run(g, meta, { kind: 'createView', label: 'Other' }) as string;
        const target = run(g, meta, { kind: 'createView', label: 'Target' }) as string;
        run(g, meta, { kind: 'addViewReference', view: source, target, at: { x: 0, y: 0 } });
        // A view places another view once.
        expect(executeCommand(g, meta, { kind: 'addViewReference', view: source, target, at: { x: 100, y: 100 } }).ok).toBe(false);
        run(g, meta, { kind: 'addViewReference', view: other, target, at: { x: 0, y: 0 } });
        const before = canonical(g.quads());

        const { result, patch } = g.transact(x => executeCommand(x, meta, { kind: 'delete', ids: [target] }));
        expect(result.ok).toBe(true);
        expect(doc(g).views[target]).toBeUndefined();
        expect(viewReferencesTo(doc(g), target)).toEqual([]);
        expect(Object.values(doc(g).views).flatMap(v => boxes(v, 'reference'))).toEqual([]);

        g.undo(patch);
        expect(canonical(g.quads())).toBe(before);
        expect(viewReferencesTo(doc(g), target)).toHaveLength(2);
    });
});

describe('arrows', () => {
    const setup = () => {
        const g = emptyGraph();
        const view = run(g, meta, { kind: 'createView', label: 'Arrows' }) as string;
        const note = run(g, meta, { kind: 'createNote', view, text: 'Why', at: { x: 0, y: 0 } }) as string;
        const card = run(g, meta, { kind: 'createInstance', classIri: 'urn:C', label: 'A', view, at: { x: 600, y: 0 } }) as string;
        const other = run(g, meta, { kind: 'createInstance', classIri: 'urn:C', label: 'B', view, at: { x: 600, y: 400 } }) as string;
        return { g, view, note, card, other };
    };

    it('stores an arrow as a statement between the note mark and the instance, shown by a placement; both go with the last placement', () => {
        const { g, view, note, card } = setup();
        const arrow = run(g, meta, { kind: 'createArrow', view, from: note, to: card }) as string;
        const v = g.views()[0];
        const mark = g.object(g.match(null, V.element).find(q => elementIdOf(q.subject) === note)!.subject, V.element, v)!;
        const instance = g.match(null, null, null, g.model).find(q => elementIdOf(q.subject) === card)!.subject;
        expect(g.match(mark, V.arrow, instance, v)).toHaveLength(1);
        expect(elementIdOf(g.arrows(v)[0])).toBe(arrow);
        const t = g.connectorOf(g.arrows(v)[0], v)!;
        expect([t.subject, t.predicate, t.object].map(x => x.value)).toEqual([mark.value, V.arrow.value, instance.value]);
        run(g, meta, { kind: 'removeFromView', view, ids: [arrow] });
        expect(g.match(null, V.arrow)).toEqual([]);
        expect(g.match(mark)).toHaveLength(2);
    });

    it('connects a note with another box in both directions, and rejects arrows without a note', () => {
        const { g, view, note, card, other } = setup();
        const out = run(g, meta, { kind: 'createArrow', view, from: note, to: card }) as string;
        const back = run(g, meta, { kind: 'createArrow', view, from: card, to: note }) as string;
        const box = placementOfId(doc(g).views[view], card);
        expect(doc(g).views[view].arrows).toEqual(expect.arrayContaining([{ id: out, from: note, to: box }, { id: back, from: box, to: note }]));
        const before = canonical(g.quads());
        for (const [from, to, error] of [[card, other, 'note'], [note, note, 'different'], [note, card, 'exists'], [note, 'n-urn_3Anone', 'two elements']]) {
            const { result, patch } = g.transact(x => executeCommand(x, meta, { kind: 'createArrow', view, from, to }));
            expect(result.ok ? '' : result.error).toContain(error);
            expect(patch).toHaveLength(0);
        }
        expect(canonical(g.quads())).toBe(before);
        // The model graph does not change: an arrow is not a relation.
        expect(Object.keys(doc(g).relations)).toEqual([]);
    });

    it('removes an arrow without its note, as one undo step', () => {
        const { g, view, note, card, other } = setup();
        const arrow = run(g, meta, { kind: 'createArrow', view, from: note, to: card }) as string;
        const before = canonical(g.quads());
        const { result, patch } = g.transact(x => executeCommand(x, meta, { kind: 'removeFromView', view, ids: [arrow] }));
        expect(result.ok).toBe(true);
        expect(doc(g).views[view].arrows).toEqual([]);
        expect(boxes(doc(g).views[view], 'note').map(n => n.id)).toEqual([note]);
        expect(boxes(doc(g).views[view], 'card').map(n => n.element).sort()).toEqual([card, other].sort());
        g.undo(patch);
        expect(canonical(g.quads())).toBe(before);
    });

    it('goes with its note or with a card that leaves the view; undo restores it', () => {
        const { g, view, note, card, other } = setup();
        run(g, meta, { kind: 'createArrow', view, from: note, to: card });
        run(g, meta, { kind: 'createArrow', view, from: other, to: note });
        const before = canonical(g.quads());
        const removeCard = g.transact(x => executeCommand(x, meta, { kind: 'removeFromView', view, ids: [card] }));
        expect(doc(g).views[view].arrows.map(a => [a.from, a.to])).toEqual([[placementOfId(doc(g).views[view], other), note]]);
        g.undo(removeCard.patch);
        expect(canonical(g.quads())).toBe(before);
        const deleteNote = g.transact(x => executeCommand(x, meta, { kind: 'removeFromView', view, ids: [note] }));
        expect(doc(g).views[view].arrows).toEqual([]);
        expect(project(g).warnings).toEqual([]);
        g.undo(deleteNote.patch);
        expect(canonical(g.quads())).toBe(before);
        run(g, meta, { kind: 'delete', ids: [other] });
        expect(doc(g).views[view].arrows.map(a => [a.from, a.to])).toEqual([[note, placementOfId(doc(g).views[view], card)]]);
    });

    it('keeps arrows and their color through a TriG round trip and a duplicated view', async () => {
        const { g, view, note, card } = setup();
        const arrow = run(g, meta, { kind: 'createArrow', view, from: note, to: card }) as string;
        run(g, meta, { kind: 'setViewElements', view, ids: [arrow], patch: { color: 'red' } });
        const copy = run(g, meta, { kind: 'duplicateView', id: view }) as string;
        const copied = doc(g).views[copy];
        expect(copied.arrows).toMatchObject([{ from: boxes(copied, 'note')[0].id, to: placementOfId(copied, card), color: 'red' }]);
        expect(boxes(copied, 'note')[0].id).not.toBe(note);

        const reopened = await load(await writeTrig(g.quads()));
        const r = project(reopened);
        expect(r.warnings).toEqual([]);
        for (const v of Object.values(r.doc.views)) expect(v.arrows).toEqual([{ id: expect.any(String), from: boxes(v, 'note')[0].id, to: placementOfId(v, card), color: 'red' }]);
    });
});

describe('card display', () => {
    it('sets simple/detailed on cards in one undo step; keeps it through save, copy and Duplicate View', async () => {
        const g = emptyGraph();
        const view = run(g, meta, { kind: 'createView', label: 'Display' }) as string;
        const target = run(g, meta, { kind: 'createView', label: 'Target' }) as string;
        const a = run(g, meta, { kind: 'createInstance', classIri: 'urn:C', label: 'A', view, at: { x: 0, y: 0 } }) as string;
        const b = run(g, meta, { kind: 'createInstance', classIri: 'urn:C', label: 'B', view, at: { x: 600, y: 0 } }) as string;
        const note = run(g, meta, { kind: 'createNote', view, text: 'n', at: { x: 0, y: 600 } }) as string;
        const before = canonical(g.quads());

        // A note id is ignored: only cards have a display.
        const { result, patch } = g.transact(x => executeCommand(x, meta, { kind: 'setViewElements', view, ids: [a, b, note], patch: { display: 'simple' } }));
        expect(result.ok).toBe(true);
        expect(boxes(doc(g).views[view], 'card').map(n => n.display)).toEqual(['simple', 'simple']);
        g.undo(patch);
        expect(canonical(g.quads())).toBe(before);
        g.redo(patch);

        run(g, meta, { kind: 'setViewElements', view, ids: [b], patch: { display: 'detailed' } });
        const byLabel = (d: Doc, label: string) =>
            Object.fromEntries(boxes(Object.values(d.views).find(x => x.label === label)!, 'card').map(n => [d.instances[n.element].label, n.display]));
        expect(byLabel(doc(g), 'Display')).toEqual({ A: 'simple', B: undefined });
        // Detailed is the default: it has no triple.
        expect(g.match(null, V.display, null, null)).toHaveLength(1);

        expect(byLabel(doc(await load(await writeTrig(g.quads()))), 'Display')).toEqual({ A: 'simple', B: undefined });
        run(g, meta, { kind: 'pasteIntoView', view: target, clip: copyFromView(doc(g), view, [a, b])!, at: { x: 0, y: 0 } });
        expect(byLabel(doc(g), 'Target')).toEqual({ 'A 2': 'simple', 'B 2': undefined });
        run(g, meta, { kind: 'duplicateView', id: view });
        expect(Object.values(doc(g).views).map(v => boxes(v, 'card').filter(n => n.display === 'simple').length).sort()).toEqual([1, 1, 1]);
    });
});

describe('setViewElements', () => {
    it('changes cards, groups, notes, references, collections and arrows with one command and one undo step', () => {
        const g = emptyGraph();
        const view = run(g, meta, { kind: 'createView', label: 'All' }) as string;
        const other = run(g, meta, { kind: 'createView', label: 'Other' }) as string;
        const a = run(g, meta, { kind: 'createInstance', classIri: 'urn:C', label: 'A', view, at: { x: 0, y: 0 } }) as string;
        const b = run(g, meta, { kind: 'createInstance', classIri: 'urn:C', label: 'B', view, at: { x: 600, y: 0 } }) as string;
        const group = run(g, meta, { kind: 'createGroup', view, label: 'G', rect: { x: 0, y: 900, width: 400, height: 300 } }) as string;
        const note = run(g, meta, { kind: 'createNote', view, text: 'n', at: { x: 0, y: 600 } }) as string;
        const reference = run(g, meta, { kind: 'addViewReference', view, target: other, at: { x: 900, y: 600 } }) as string;
        const collection = run(g, meta, { kind: 'collect', view, ids: [b] }) as string;
        const arrow = run(g, meta, { kind: 'createArrow', view, from: note, to: a }) as string;
        const before = canonical(g.quads());

        const ids = [a, group, note, reference, collection, arrow];
        const { result, patch } = g.transact(x => executeCommand(x, meta, { kind: 'setViewElements', view, ids, patch: { color: '3' } }));
        expect(result.ok).toBe(true);
        const v = doc(g).views[view];
        expect([cardOf(v, a), ...boxes(v, 'group'), ...boxes(v, 'note'), ...boxes(v, 'reference'), ...boxes(v, 'collection'), ...v.arrows].map(x => x?.color))
            .toEqual(['3', '3', '3', '3', '3', '3']);
        g.undo(patch);
        expect(canonical(g.quads())).toBe(before);

        // Label and text go to the element kind that has them; a group keeps its minimum size.
        run(g, meta, { kind: 'setViewElements', view, ids: [group], patch: { label: 'H', width: 10 } });
        run(g, meta, { kind: 'setViewElements', view, ids: [note], patch: { text: 'm' } });
        expect(boxes(doc(g).views[view], 'group')[0]).toMatchObject({ label: 'H', width: 160 });
        expect(boxes(doc(g).views[view], 'note')[0].text).toBe('m');
        expect(g.transact(x => executeCommand(x, meta, { kind: 'setViewElements', view, ids: [group], patch: { label: ' ' } })).result.ok).toBe(false);
        expect(g.transact(x => executeCommand(x, meta, { kind: 'setViewElements', view, ids: ['n-missing'], patch: { color: '1' } })).result.ok).toBe(false);
    });
});

describe('IRIs of view elements (ADR 0011)', () => {
    const P_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const iriOf = (id: string) => elementTermOf(id)!.value;
    const elementTermOf = (id: string) => (id.startsWith('n-') ? { value: id.slice(2).replace(/_([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) } : undefined);

    it('placement <view>/p/<hash of what it places> with view:view; mark <view>/m/<id>; duplicateView and a view IRI change follow', () => {
        const g = emptyGraph();
        const view = run(g, meta, { kind: 'createView', label: 'V' }) as string;
        const note = run(g, meta, { kind: 'createNote', view, text: 'hello', at: { x: 0, y: 0 } }) as string;
        const card = run(g, meta, { kind: 'createInstance', classIri: 'urn:C', label: 'A', view, at: { x: 600, y: 0 } }) as string;
        run(g, meta, { kind: 'createArrow', view, from: note, to: card });
        const v = g.views()[0];
        const check = (graph: typeof v) => {
            const placements = g.subjects(rdf.namedNode(P_TYPE), V.Placement, graph);
            expect(placements.length).toBe(3);
            for (const p of placements) {
                expect(g.objects(p, V.view, graph).map(t => t.value)).toEqual([graph.value]);
                const placed = g.object(p, V.element, graph) ?? g.connectorOf(p, graph)!;
                expect(p.value).toBe(placementIri(graph.value, placed).value);
            }
            const mark = g.subjects(rdf.namedNode(P_TYPE), V.Note, graph)[0];
            expect(mark.value).toMatch(new RegExp(`^${graph.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/m/[0-9a-z]{6}$`));
        };
        check(v);
        expect(iriOf(note)).toMatch(/\/p\/[0-9a-f]{12}$/);

        run(g, meta, { kind: 'duplicateView', id: view });
        const copy = g.views().find(x => !x.equals(v))!;
        check(copy);
        expect(g.match(null, null, null, copy).filter(q => !q.subject.equals(copy)).every(q => q.subject.value.startsWith(copy.value + '/'))).toBe(true);

        run(g, meta, { kind: 'setUri', id: view, uri: 'urn:name:Renamed' });
        const renamed = rdf.namedNode('urn:name:Renamed');
        check(renamed);
        expect(g.match(null, null, null, renamed).filter(q => !q.subject.equals(renamed)).every(q => q.subject.value.startsWith('urn:name:Renamed/'))).toBe(true);
    });
});

