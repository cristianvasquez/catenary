import { describe, expect, it, vi } from 'vitest';

// The GLSP and Theia modules need a browser; the sync uses only these names of them.
vi.mock('@eclipse-glsp/client', () => ({
    SelectAction: { create: (a: { selectedElementsIDs: string[]; deselectedElementsIDs: boolean | string[] }) => ({ kind: 'elementSelected', ...a }) },
    SystemCommand: class {},
    TYPES: { Action: Symbol('Action'), IVNodePostprocessor: Symbol('IVNodePostprocessor') },
    setClass: () => undefined
}));
vi.mock('@eclipse-glsp/theia-integration', () => ({ GLSPDiagramWidget: class {} }));
vi.mock('@theia/core/lib/browser', () => ({ ApplicationShell: class {} }));
vi.mock('../src/browser/diagram/view-editors', () => ({ ViewEditors: class {}, viewIdOf: (w: { view: string }) => w.view }));

import { Emitter } from '@theia/core/lib/common/event';
import { ModelSelection, ModelSnapshot, emptySelected } from '@catenary/model';
import { ModelFrontend } from '../src/browser/model-client';
import { SelectionModel } from '../src/browser/selection-model';
import { CanvasHighlight, HighlightAction } from '../src/browser/diagram/canvas-highlight';
import { diagramIds } from '../src/browser/diagram/diagram-ids';
import { DiagramSelectionSync } from '../src/browser/diagram/selection-sync';
import { ViewEditors } from '../src/browser/diagram/view-editors';

type Dispatched = { kind: string; selectedElementsIDs?: string[]; ids?: string[] };

/**
 * A view editor as the sync sees it: its view, the client model that it keeps (cards pa, pb in view A; qa, qb in view B, of elements
 * a and b), its GLSP selection and the actions that it gets. A SelectAction changes the GLSP selection; a HighlightAction the highlight.
 */
function canvas(view: string, cards: Record<string, string>) {
    const highlight = new CanvasHighlight();
    const ids = diagramIds(Object.entries(cards).map(([id, element]) => ({ id, element })));
    const rootChanged = new Emitter<void>();
    const w = {
        view, ids, highlight, rootChanged, dispatched: [] as Dispatched[], selected: [] as string[],
        /** As the GLSP dispatcher: an action applies after the current task (a microtask here), not during dispatch. */
        async: false,
        /** The actions that the asynchronous dispatcher has not applied yet (`settle` waits for them). */
        queued: [] as Promise<void>[],
        viewerOptions: { baseDiv: `base-${view}` },
        node: { contains: () => true },
        disposed: { connect: () => undefined },
        diContainer: { get: () => highlight },
        editorContext: {
            modelRoot: { id: view },
            get selectedElements() { return w.selected.map(id => ({ id })); },
            onModelRootChanged: rootChanged.event
        },
        actionDispatcher: {
            dispatch(a: Dispatched & { deselectedElementsIDs?: boolean | string[] }) {
                w.dispatched.push(a);
                const apply = () => {
                    if (a.kind === 'elementSelected') {
                        const kept = a.deselectedElementsIDs === true ? [] : w.selected.filter(id => !(a.deselectedElementsIDs as string[] ?? []).includes(id));
                        w.selected = [...new Set([...kept, ...a.selectedElementsIDs ?? []])];
                    }
                    if (a.kind === HighlightAction.KIND) highlight.ids = new Set(a.ids);
                };
                if (w.async) w.queued.push(new Promise<void>(done => queueMicrotask(() => { apply(); done(); })));
                else apply();
            }
        },
        /** A user gesture: GLSP selects, and the forwarder (the canvas has the focus) sets the window selection. */
        click(selection: SelectionModel, ...placements: string[]) {
            w.selected = placements;
            selection.set({ view, ids: placements });
        }
    };
    return w;
}
type Canvas = ReturnType<typeof canvas>;

function setup() {
    const snapshots = new Emitter<ModelSnapshot>();
    const model = {
        onDidChange: snapshots.event, isOpen: true, snapshot: { revision: 0, movedIds: {} } as unknown as ModelSnapshot,
        service: { selected: async (s: ModelSelection) => ({ ...emptySelected(), view: s.view, ids: s.ids }) }
    };
    const selection = Object.assign(new SelectionModel(), { model: model as unknown as ModelFrontend });
    (selection as unknown as { init(): void }).init();
    const A = canvas('A', { pa: 'a', pb: 'b' }), B = canvas('B', { qa: 'a', qb: 'b' });
    const all = [A, B];
    const editors = {
        all: () => all,
        diagram: (w: Canvas) => w.ids,
        elementIn: (view: string, id: string) => all.find(w => w.view === view)?.ids.elementOf(id) ?? id
    };
    const shell = { onDidAddWidget: () => undefined };
    const sync = Object.assign(new DiagramSelectionSync(), { editors: editors as unknown as ViewEditors, selection, model: model as unknown as ModelFrontend, shell });
    vi.stubGlobal('window', { addEventListener: () => undefined });
    sync.onStart();
    const events: ModelSelection[] = [];
    selection.onDidChange(s => events.push(s));
    const reset = () => { events.length = 0; A.dispatched.length = 0; B.dispatched.length = 0; };
    reset();
    return { selection, snapshots, sync, A, B, events, reset };
}

const selects = (w: Canvas) => w.dispatched.filter(a => a.kind === 'elementSelected');
const highlights = (w: Canvas) => w.dispatched.filter(a => a.kind === HighlightAction.KIND);

describe('selection sync (spec/ui-manifest.hs §3.3 law_oneSelectionPerWindow)', () => {
    it('law_oneSelectionPerWindow: one click gives one selection event and no SelectAction from the sync; the other canvas highlights', () => {
        const { selection, A, B, events } = setup();
        A.click(selection, 'pa');
        expect(events).toEqual([{ view: 'A', ids: ['pa'] }]);
        // The origin keeps the GLSP selection of the gesture: no echo.
        expect(selects(A)).toEqual([]);
        expect(A.selected).toEqual(['pa']);
        expect([...A.highlight.ids]).toEqual([]);
        // The other canvas: a highlight of the same element, no GLSP selection.
        expect(selects(B)).toEqual([]);
        expect(B.selected).toEqual([]);
        expect([...B.highlight.ids]).toEqual(['qa']);
    });

    it('law_oneSelectionPerWindow: a gesture in the highlighting canvas makes it the origin; the old origin gets one deselect', () => {
        const { selection, A, B, events, reset } = setup();
        A.click(selection, 'pa');
        reset();
        B.click(selection, 'qb');
        expect(events).toEqual([{ view: 'B', ids: ['qb'] }]);
        expect(selects(B)).toEqual([]);
        expect([...B.highlight.ids]).toEqual([]);
        expect(selects(A)).toEqual([{ kind: 'elementSelected', selectedElementsIDs: [], deselectedElementsIDs: true }]);
        expect([...A.highlight.ids]).toEqual(['pb']);
        expect(A.selected).toEqual([]);
    });

    it('law_oneSelectionPerWindow: a selection set by a command selects in its origin only; a listing selection highlights in each canvas', () => {
        const { selection, A, B } = setup();
        selection.set({ view: 'B', ids: ['qa', 'qb'] });
        expect(selects(B)).toEqual([{ kind: 'elementSelected', selectedElementsIDs: ['qa', 'qb'], deselectedElementsIDs: true }]);
        expect(selects(A)).toEqual([]);
        expect([...A.highlight.ids].sort()).toEqual(['pa', 'pb']);
        selection.set({ ids: ['a'] });
        expect(B.selected).toEqual([]);
        expect([...A.highlight.ids]).toEqual(['pa']);
        expect([...B.highlight.ids]).toEqual(['qa']);
    });

    it('law_oneSelectionPerWindow: a model change or a model update of a canvas sends no SelectAction', () => {
        const { selection, snapshots, A, B, reset } = setup();
        A.click(selection, 'pa');
        reset();
        snapshots.fire({ revision: 1, movedIds: {}, change: { reason: 'edit', tier: 'data' } } as unknown as ModelSnapshot);
        A.rootChanged.fire();
        B.rootChanged.fire();
        expect([...selects(A), ...selects(B)]).toEqual([]);
        // The origin draws again for the halo of its one selected element; the highlight of B is unchanged.
        expect(highlights(A)).toEqual([{ kind: HighlightAction.KIND, ids: [] }]);
        expect(highlights(B)).toEqual([]);
    });

    it('law_oneSelectionPerWindow: an element that arrives in the origin after the selection is selected there once', () => {
        const { selection, A, B } = setup();
        selection.set({ view: 'A', ids: ['pc'] });
        expect(selects(A)).toEqual([]);
        A.ids = diagramIds([{ id: 'pa', element: 'a' }, { id: 'pb', element: 'b' }, { id: 'pc', element: 'c' }]);
        A.rootChanged.fire();
        A.rootChanged.fire();
        expect(selects(A)).toEqual([{ kind: 'elementSelected', selectedElementsIDs: ['pc'], deselectedElementsIDs: true }]);
        expect(selects(B)).toEqual([]);
    });

    /**
     * A Ctrl press on an element of B, then what GLSP does with the press when it gets it: it reads the `selected` flag of the
     * element at once and adds or removes it (sprotty SelectMouseListener).
     */
    function ctrlPress(sync: DiagramSelectionSync, w: Canvas, id?: string) {
        let stopped = false;
        const el = (elId: string, parent: unknown) => ({ id: elId, parentElement: parent });
        const target = id ? el(`${w.viewerOptions.baseDiv}_${id}`, el('', w.node)) : el('', w.node);
        const press = {
            button: 0, ctrlKey: true, metaKey: false, shiftKey: false, stopPropagation: () => { stopped = true; },
            target: { ...target, closest: () => ({}) }
        } as unknown as MouseEvent;
        (sync as unknown as { press(e: MouseEvent): void }).press(press);
        if (!stopped && id) {
            const on = w.selected.includes(id);
            w.actionDispatcher.dispatch({ kind: 'elementSelected', selectedElementsIDs: on ? [] : [id], deselectedElementsIDs: on ? [id] : [] });
        }
    }
    /** Wait until both dispatchers have applied their actions, also the actions that an applied action dispatched. */
    async function settle(...ws: Canvas[]) {
        for (let queued = ws.flatMap(w => w.queued.splice(0)); queued.length; queued = ws.flatMap(w => w.queued.splice(0))) await Promise.all(queued);
    }

    it('law_oneSelectionPerWindow: a Ctrl click on a highlighted element removes it, with an asynchronous dispatcher', async () => {
        const { selection, sync, A, B } = setup();
        A.async = B.async = true;
        A.click(selection, 'pa', 'pb');
        await settle(A, B);
        expect([...B.highlight.ids].sort()).toEqual(['qa', 'qb']);
        A.node.contains = () => false;   // the press is in B
        ctrlPress(sync, B, 'qa');
        await settle(A, B);
        expect(selection.selection).toEqual({ view: 'B', ids: ['qb'] });
        expect(B.selected).toEqual(['qb']);
        expect([...B.highlight.ids]).toEqual([]);
        expect(A.selected).toEqual([]);
        expect([...A.highlight.ids]).toEqual(['pb']);
    });

    it('law_oneSelectionPerWindow: a Ctrl press on the title of a group adds the group, also when the index holds the label', async () => {
        const { selection, sync, A, B } = setup();
        A.async = B.async = true;
        B.ids = diagramIds([{ id: 'qa', element: 'a' }, { id: 'qb', element: 'b' }, { id: 'qg' }, { id: 'qg_label' }]);
        A.click(selection, 'pa');
        await settle(A, B);
        A.node.contains = () => false;
        ctrlPress(sync, B, 'qg_label');
        await settle(A, B);
        expect(selection.selection).toEqual({ view: 'B', ids: ['qa', 'qg'] });
    });

    it('law_oneSelectionPerWindow: a Ctrl click on another element of the highlighting canvas adds it; that canvas becomes the origin', async () => {
        const { selection, sync, A, B } = setup();
        A.async = B.async = true;
        A.click(selection, 'pa');
        await settle(A, B);
        A.node.contains = () => false;
        ctrlPress(sync, B, 'qb');
        await settle(A, B);
        expect(selection.selection).toEqual({ view: 'B', ids: ['qa', 'qb'] });
        expect(B.selected.sort()).toEqual(['qa', 'qb']);
        expect(A.selected).toEqual([]);
        expect([...A.highlight.ids].sort()).toEqual(['pa', 'pb']);
    });

    it('law_oneSelectionPerWindow: a Ctrl press on empty canvas (a marquee) first takes the highlight as its GLSP selection', () => {
        const { selection, sync, A, B } = setup();
        A.click(selection, 'pa');
        A.node.contains = () => false;
        ctrlPress(sync, B);
        expect(selects(B)).toEqual([{ kind: 'elementSelected', selectedElementsIDs: ['qa'], deselectedElementsIDs: true }]);
        expect([...B.highlight.ids]).toEqual([]);
    });
});
