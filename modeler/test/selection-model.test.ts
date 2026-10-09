import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '@theia/core/lib/common/event';
import { Doc, ModelSelection, ModelSnapshot, View, emptyDoc, boxes } from '@catenary/model';
import { resolveSelection, selectionInView } from '../../packages/model/test/doc-reference';
import { ModelFrontend } from '../src/browser/model-client';
import { SelectionModel } from '../src/browser/selection-model';

const box = { x: 0, y: 0, width: 100, height: 50 };
const view = (id: string, instances: string[], extra: Partial<View> = {}): View =>
    ({ id, label: id, uri: id, edges: [], arrows: [], ...extra, boxes: [...instances.map(i => ({ kind: 'card' as const, id: i, element: i, ...box })), ...(extra.boxes ?? [])] });

/** Instances a, b, c; relation a→b; view A shows a, b and group g; view B shows a and c. */
function doc(): Doc {
    const d = emptyDoc();
    for (const id of ['a', 'b', 'c']) d.instances[id] = { id, label: id, types: [], uri: id, fields: {} };
    d.relations.ab = { id: 'ab', subject: 'a', predicate: 'p', object: 'b' };
    d.views.A = view('A', ['a', 'b'], { boxes: [{ kind: 'group', id: 'g', label: 'g', ...box }] });
    d.views.B = view('B', ['a', 'c']);
    return d;
}
const snapshot = (revision: number, movedIds: Record<string, string> = {}): ModelSnapshot => ({
    revision, shapesVersion: 0, file: '/m.trig', files: { files: [], views: [] }, meta: { classes: [] }, counts: { instances: 0, results: 0, violations: 0 },
    warnings: [], migrations: [], movedIds, prefixes: { table: {}, stored: false }, dirty: false, canUndo: false, canRedo: false
});

/** A SelectionModel on a fake backend: `selected` resolves on the read model `current`, as ModelStore does. */
function selectionModel() {
    const snapshots = new Emitter<ModelSnapshot>();
    let current = doc();
    const model = {
        onDidChange: snapshots.event, isOpen: true, snapshot: snapshot(0),
        service: { selected: async (sel: ModelSelection) => resolveSelection(current, sel) }
    };
    const s = Object.assign(new SelectionModel(), { model: model as unknown as ModelFrontend });
    (s as unknown as { init(): void }).init();
    const push = async (d: Doc, snap: ModelSnapshot) => {
        current = d;
        model.snapshot = snap;
        snapshots.fire(snap);
        await vi.waitFor(() => expect(s.resolved.ids).toEqual(s.selection.ids));
    };
    return { s, push, model, snapshots };
}

describe('selection model', () => {
    it('each view shows the model elements that it has, and view-owned elements only in the view of the selection', () => {
        const d = doc();
        const sel = { view: 'A', ids: ['a', 'ab', 'g', 'c'] };
        expect(selectionInView(d, sel, 'A')).toEqual(['a', 'ab', 'g']);
        expect(selectionInView(d, sel, 'B')).toEqual(['a', 'c']);
        expect(selectionInView(d, { view: 'B', ids: ['g'] }, 'A')).toEqual([]);
    });

    it('a concept of two scheme or collection cards of the view is a row of each: it has no card to select (ADR 0014)', () => {
        const d = doc();
        for (const id of ['s1', 's2']) {
            d.shapes.valueSets[id] = { id, uri: id, kind: 'scheme', label: id, file: '', members: [{ uri: 'c', label: 'c' }] };
            d.views.A.boxes.push({ kind: 'card', id, element: id, ...box });
        }
        expect(selectionInView(d, { view: 'A', ids: ['c'] }, 'A')).toEqual([]);
    });

    it('fires only on a change, in any order of ids', () => {
        const { s } = selectionModel();
        const changed = vi.fn();
        s.onDidChange(changed);
        s.set({ view: 'A', ids: ['a', 'b'] });
        s.set({ view: 'A', ids: ['b', 'a', 'a'] });
        expect(changed).toHaveBeenCalledTimes(1);
        s.set({ view: 'B', ids: ['a', 'b'] });
        expect(changed).toHaveBeenCalledTimes(2);
    });

    it('follows IRI changes and drops deleted elements after a model change', async () => {
        const { s, push } = selectionModel();
        s.set({ view: 'A', ids: ['a', 'b', 'g'] });
        await vi.waitFor(() => expect(s.resolved.instances).toEqual(['a', 'b']));
        const d = doc();
        d.instances.a2 = { ...d.instances.a, id: 'a2' };
        delete d.instances.a;
        delete d.instances.b;
        d.views.A.boxes = [...boxes(d.views.A, 'group'), { kind: 'card', id: 'a2', element: 'a2', ...box }];
        await push(d, snapshot(1, { a: 'a2' }));
        expect(s.selection).toEqual({ view: 'A', ids: ['a2', 'g'] });
        expect(s.resolved).toMatchObject({ view: 'A', instances: ['a2'], groups: ['g'] });
        delete d.views.A;
        await push(d, snapshot(2));
        expect(s.selection).toEqual({ view: undefined, ids: ['a2'] });
    });

    it('law_selectionNoReadForUnchangedPanels: save and layout keep selection facts without a request', async () => {
        const { s, model, snapshots } = selectionModel();
        const selected = vi.spyOn(model.service, 'selected');
        s.set({ view: 'A', ids: ['a'] });
        await s.resolve();
        selected.mockClear();
        const resolved = vi.fn();
        s.onDidResolve(resolved);
        for (const change of [{ reason: 'save' }, { reason: 'edit', layout: true }, { reason: 'validation' }] as ModelSnapshot['change'][]) {
            model.snapshot = { ...snapshot(model.snapshot.revision + 1), change };
            snapshots.fire(model.snapshot);
            await s.resolve();
        }
        expect(selected).not.toHaveBeenCalled();
        expect(resolved).not.toHaveBeenCalled();
        expect(s.resolved.instances).toEqual(['a']);
    });

    it('law_selectionRejectsOldRevision: an older snapshot response cannot replace newer facts', async () => {
        const { s, model, snapshots } = selectionModel();
        s.set({ ids: ['a'] });
        await s.resolve();
        const pending: ((value: ReturnType<typeof resolveSelection>) => void)[] = [];
        model.service.selected = () => new Promise(resolve => pending.push(resolve));
        model.snapshot = snapshot(1);
        snapshots.fire(model.snapshot);
        model.snapshot = snapshot(2);
        snapshots.fire(model.snapshot);
        const changed = vi.fn();
        s.onDidResolve(changed);
        pending[1](resolveSelection(doc(), { ids: ['a'] }));
        await Promise.resolve();
        pending[0](resolveSelection(doc(), { ids: [] }));
        await Promise.resolve();
        expect(s.resolved.instances).toEqual(['a']);
        expect(s.selection.ids).toEqual(['a']);
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('an answer for an older selection does not replace the resolved selection', async () => {
        const { s } = selectionModel();
        s.set({ ids: ['a'] });
        s.set({ ids: ['b'] });
        await vi.waitFor(() => expect(s.resolved.instances).toEqual(['b']));
        await new Promise(r => setTimeout(r, 0));
        expect(s.resolved.instances).toEqual(['b']);
    });
});

describe('placements in the selection (M1b)', () => {
    /** View P places a (card pa) and the relation ab (edge pab); view Q places a (card qa) and b (card qb). */
    function placed(): Doc {
        const d = doc();
        d.views.P = { id: 'P', label: 'P', uri: 'P', arrows: [], edges: [{ id: 'pab', relation: 'ab' }],
            boxes: [{ kind: 'card', id: 'pa', element: 'a', ...box }, { kind: 'card', id: 'pb', element: 'b', ...box }] };
        d.views.Q = { id: 'Q', label: 'Q', uri: 'Q', arrows: [], edges: [{ id: 'qab', relation: 'ab' }],
            boxes: [{ kind: 'card', id: 'qa', element: 'a', ...box }, { kind: 'card', id: 'qb', element: 'b', ...box }] };
        return d;
    }

    it('a canvas selection of placements gives their elements to the panels', () => {
        expect(resolveSelection(placed(), { view: 'P', ids: ['pa', 'pab'] })).toMatchObject({ ids: ['pa', 'pab'], elements: ['a', 'ab'], instances: ['a'], relations: ['ab'] });
    });

    it('each canvas selects the placements of the selected elements; a listing selection (elements) too', () => {
        const d = placed();
        expect(selectionInView(d, { view: 'P', ids: ['pa', 'pab'] }, 'P').sort()).toEqual(['pa', 'pab']);
        expect(selectionInView(d, { view: 'P', ids: ['pa', 'pab'] }, 'Q').sort()).toEqual(['qa', 'qab']);
        expect(selectionInView(d, { ids: ['a'] }, 'Q')).toEqual(['qa']);
    });
});

