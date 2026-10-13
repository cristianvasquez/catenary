import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    Action, ActionMessage, ChangeBoundsOperation, DefaultActionDispatcher, DefaultGModelSerializer, DefaultModelState, DeleteElementOperation, GModelIndex, MessageAction,
    ModelSubmissionHandler, NullLogger, RequestModelAction, SetDirtyStateAction, SetModelAction, UpdateModelAction, PasteOperation, FitToScreenAction, SelectAction
} from '@eclipse-glsp/server';
import { NodeActionDispatchScope } from '@eclipse-glsp/server/node';
import { GNodeSchema } from '@eclipse-glsp/protocol';
import { Doc, EditCommand, NS, boxes, cardOf, copyFromView, VIEW_CLIP_FORMAT } from '@catenary/model';

/** A diagram element by the id of what it shows: a card or a placed edge by its element (its id is the id of its placement). */
const key = (e: { id: string; element?: unknown }) => (e.element as string | undefined) ?? e.id;
import { ModelStore } from '@catenary/rdf';
import { ModelGraph } from '../../packages/rdf/src/graph';
import { elementId } from '../../packages/rdf/src/ids';
import { rdf } from '../../packages/rdf/src/terms';
import { ViewDiagramConfiguration } from '../src/node/glsp/diagram-module';
import { RevisionGuardForwarder, StoreCommandStack, ViewGModelFactory, ViewSession, ViewState } from '../src/node/glsp/view-session';
import { ChangeBoundsHandler, DeleteHandler, PasteHandler, SetVisibleAction, SetVisibleHandler, VisibleSetAction } from '../src/node/glsp/handlers';
import { docOf } from '../../packages/rdf/test/helpers';
import { PASTE_RESULT } from '../src/common/protocol';

/** Real store -> part query -> schema -> GLSP model -> update actions. Only the client transport is replaced. */
async function client(store: ModelStore, viewId: string) {
    const state = Object.assign(new ViewState(), { store });
    const diagramConfiguration = new ViewDiagramConfiguration();
    const serializer = Object.assign(new DefaultGModelSerializer(), { diagramConfiguration });
    const modelState = Object.assign(new DefaultModelState(), { index: new GModelIndex(), serializer });
    const commandStack = Object.assign(new StoreCommandStack(), { store });
    const modelFactory = Object.assign(new ViewGModelFactory(), { session: state, modelState, serializer });
    const submission = Object.assign(new ModelSubmissionHandler(), { diagramConfiguration, serializer, modelState, modelFactory, commandStack });
    const sent: Action[] = [];
    const dispatcher = {
        dispatch: vi.fn(async (a: Action) => { sent.push(a); }),
        dispatchAll: vi.fn(async (actions: Action[]) => { sent.push(...actions); })
    };
    const sessions = { addListener: vi.fn(), removeListener: vi.fn() };
    const session = Object.assign(new ViewSession(), { state, submission, dispatcher, sessions, clientId: viewId, modelState });
    const refresh = vi.spyOn(session, 'refresh');
    session.start(viewId);
    await session.refresh();
    sent.length = 0;
    refresh.mockClear();
    return {
        session, state, sent, refresh, modelState,
        // Wait for actual refresh promises, not a time estimate of how long propagation takes.
        flushed: () => Promise.all(refresh.mock.results.map(r => r.value)),
        elements: () => serializer.createSchema(modelState.root).children!,
        dispose: () => sessions.addListener.mock.calls[0][0].sessionDisposed(),
        commandStack
    };
}

/**
 * The session with the GLSP action queue: a real DefaultActionDispatcher (queue and dispatch scope of the node backend) and the
 * forwarder of the diagram module. `received`: the actions that reach the client transport. `wait(kind)`: a client action whose
 * handler waits until `release` (as `catenarySetVisible` or `catenaryLayoutView`). `move(kind, command)`: a client action whose handler
 * runs a canvas edit (as ChangeBoundsHandler).
 */
async function queuedClient(store: ModelStore, viewId: string) {
    const state = Object.assign(new ViewState(), { store });
    const diagramConfiguration = new ViewDiagramConfiguration();
    const serializer = Object.assign(new DefaultGModelSerializer(), { diagramConfiguration });
    const modelState = Object.assign(new DefaultModelState(), { index: new GModelIndex(), serializer });
    const commandStack = Object.assign(new StoreCommandStack(), { store });
    const modelFactory = Object.assign(new ViewGModelFactory(), { session: state, modelState, serializer });
    const received: Action[] = [];
    const forwarder = Object.assign(new RevisionGuardForwarder(new Set([SetModelAction.KIND, UpdateModelAction.KIND, SetDirtyStateAction.KIND, MessageAction.KIND])), {
        clientId: viewId, glspClient: { process: (m: ActionMessage) => { received.push(m.action); } }
    });
    const handlers = new Map<string, { actionKinds: string[]; execute: (a: Action) => Promise<Action[]> }>();
    const dispatcher = Object.assign(new DefaultActionDispatcher(), {
        actionHandlerRegistry: { get: (kind: string) => handlers.has(kind) ? [handlers.get(kind)!] : [] },
        clientActionForwarder: forwarder, logger: new NullLogger(), clientId: viewId, dispatchScope: new NodeActionDispatchScope()
    });
    (dispatcher as unknown as { initialize(): void }).initialize();
    const submission = Object.assign(new ModelSubmissionHandler(), { diagramConfiguration, serializer, modelState, modelFactory, commandStack, actionDispatcher: dispatcher });
    const sessions = { addListener: vi.fn(), removeListener: vi.fn() };
    const session = Object.assign(new ViewSession(), { state, submission, dispatcher, sessions, clientId: viewId, modelState });
    const refresh = vi.spyOn(session, 'refresh');
    session.start(viewId);
    // The initial model, as RequestModelActionHandler sends it: a SetModelAction with revision 0.
    await dispatcher.dispatchAll(await submission.submitInitialModel(RequestModelAction.create({ options: { uri: viewId } })));
    let release = () => {};
    handlers.set('testWait', { actionKinds: ['testWait'], execute: () => new Promise<Action[]>(resolve => { release = () => resolve([]); }) });
    return {
        session, dispatcher, received, refresh, modelState,
        updates: () => received.filter(UpdateModelAction.is),
        flushed: () => Promise.all(refresh.mock.results.map(r => r.value)),
        wait: () => dispatcher.dispatch({ kind: 'testWait' }),
        release: () => release(),
        move: (command: EditCommand) => {
            handlers.set('testMove', { actionKinds: ['testMove'], execute: async () => { await session.edit(command); return []; } });
            return dispatcher.dispatch({ kind: 'testMove' });
        },
        dispose: () => { dispatcher.dispose(); sessions.addListener.mock.calls[0][0].sessionDisposed(); }
    };
}
const macrotask = () => new Promise<void>(resolve => setImmediate(resolve));

let dir: string;
let store: ModelStore;
let first: string;
let second: string;
let instance: string;
function edit(command: EditCommand): string {
    const result = store.execute(command);
    if (!result.ok) throw new Error(result.error);
    return result.id!;
}

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dir = mkdtempSync(join(tmpdir(), 'catenary-view-'));
    store = new ModelStore();
    expect(await store.create(join(dir, 'workspace.trig'), { instances: 'data.ttl' })).toEqual({ ok: true });
    first = edit({ kind: 'createView', label: 'First' });
    second = edit({ kind: 'createView', label: 'Second' });
    instance = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Shared', view: first, at: { x: 200, y: 200 } });
    edit({ kind: 'addToView', view: second, ids: [instance], at: { x: 600, y: 300 } });
    expect(await store.save()).toEqual({ ok: true });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
});

describe('model changes reaching view clients', () => {
    it('updates all views of an instance on rename, undo and redo, without refreshing an unrelated view', async () => {
        const unrelated = edit({ kind: 'createView', label: 'Unrelated' });
        const a = await client(store, first), b = await client(store, second), c = await client(store, unrelated);
        const expectNames = async (name: string) => {
            await Promise.all([a.flushed(), b.flushed()]);
            for (const view of [a, b]) {
                expect(view.elements().find(e => key(e) === instance)).toMatchObject({ name });
                expect(view.sent.some(UpdateModelAction.is)).toBe(true);
            }
            expect(c.refresh).not.toHaveBeenCalled();
        };
        edit({ kind: 'rename', id: instance, label: 'Changed' });
        await expectNames('Changed');
        a.commandStack.undo();
        await expectNames('Shared');
        b.commandStack.redo();
        await expectNames('Changed');
    });

    it('sends the halo counts of a card (related instances that the view does not show) and updates them after a change', async () => {
        const a = await client(store, first);
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ hiddenIn: 0, hiddenOut: 0 });
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other' });
        // A shape that permits the relation urn:p between instances of urn:Class.
        const shape = edit({ kind: 'createNodeShape', label: 'Class shape', targetClass: 'urn:Class' });
        edit({ kind: 'createPropertyShape', shape, path: { kind: 'iri', iri: 'urn:p' }, range: { kind: 'class', class: 'urn:Class' } });
        await a.flushed();
        edit({ kind: 'setStatements', id: instance, values: { 'urn:p': [{ termType: 'NamedNode', value: docOf(store).instances[other].uri }] } });
        await a.flushed();
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ hiddenIn: 0, hiddenOut: 1 });
        edit({ kind: 'addToView', view: first, ids: [other], at: { x: 700, y: 200 } });
        await a.flushed();
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ hiddenIn: 0, hiddenOut: 0 });
    });

    it('sends a collection with its members instead of their cards, and the cards again after uncollect', async () => {
        const a = await client(store, first);
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other', view: first, at: { x: 700, y: 200 } });
        await a.flushed();
        const collection = edit({ kind: 'collect', view: first, ids: [instance, other] });
        await a.flushed();
        expect(a.elements().map(e => e.id)).toEqual([collection]);
        expect(a.elements()[0]).toMatchObject({ type: 'node:collection', members: [{ id: other, label: 'Other' }, { id: instance, label: 'Shared' }] });
        edit({ kind: 'uncollect', view: first, id: collection });
        await a.flushed();
        expect(a.elements().map(key).sort()).toEqual([instance, other].sort());
    });

    it('sends arrows as edges between the drawn boxes: a collected card gives its collection, a removed note removes the arrow', async () => {
        const a = await client(store, first);
        const note = edit({ kind: 'createNote', view: first, text: 'See', at: { x: -600, y: 0 } });
        const arrow = edit({ kind: 'createArrow', view: first, from: note, to: instance });
        await a.flushed();
        expect(a.elements().find(e => e.id === arrow)).toMatchObject({ type: 'edge:arrow', sourceId: note, targetId: cardOf(docOf(store).views[first], instance)!.id });
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other', view: first, at: { x: 700, y: 200 } });
        const collection = edit({ kind: 'collect', view: first, ids: [instance, other] });
        await a.flushed();
        expect(a.elements().find(e => e.id === arrow)).toMatchObject({ sourceId: note, targetId: collection });
        edit({ kind: 'removeFromView', view: first, ids: [note] });
        await a.flushed();
        expect(a.elements().map(e => e.id)).toEqual([collection]);
    });

    it('law_edgeRemovalUpdatesDisplay: removes an instance edge without reading or replacing unrelated cards', async () => {
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other', view: first, at: { x: 700, y: 200 } });
        const shape = edit({ kind: 'createNodeShape', label: 'Class shape', targetClass: 'urn:Class' });
        edit({ kind: 'createPropertyShape', shape, path: { kind: 'iri', iri: 'urn:p' }, range: { kind: 'class', class: 'urn:Class' } });
        edit({ kind: 'createPropertyShape', shape, path: { kind: 'iri', iri: 'urn:q' }, range: { kind: 'class', class: 'urn:Class' } });
        const uri = docOf(store).instances[other].uri;
        edit({ kind: 'setStatements', id: instance, values: { 'urn:p': [{ termType: 'NamedNode', value: uri }], 'urn:q': [{ termType: 'NamedNode', value: uri }] } });
        const a = await client(store, first);
        const edge = a.state.view!.edges.find(e => e.id)!;
        edit({ kind: 'setEdgeLayout', view: first, relation: edge.relation, patch: { color: '#ff0000' } });
        await a.flushed();
        edit({ kind: 'setEdgeLayout', view: first, relation: edge.relation, patch: { color: '' } });
        await a.flushed();
        expect(a.elements().some(e => e.id === edge.id)).toBe(true);
        expect(a.elements().filter(e => e.type === "edge:relation")).toHaveLength(2);
        const card = a.modelState.root.children.find(e => key(e) === instance);
        const read = vi.spyOn(store, 'viewDoc');
        edit({ kind: 'removeFromView', view: first, ids: [edge.id!] });
        expect(read).not.toHaveBeenCalled(); // Edit completion precedes the display read.
        await a.flushed();
        expect(read).not.toHaveBeenCalled();
        expect(a.elements().some(e => e.id === edge.id)).toBe(false);
        expect(a.elements().find(e => e.type === "edge:relation")).toMatchObject({ lane: 0, lanes: 1 });
        expect(a.modelState.root.children.find(e => key(e) === instance)).toBe(card);
        expect(docOf(store).relations[edge.relation]).toBeDefined();
        store.undo();
        await a.flushed();
        expect(a.elements().some(e => e.id === edge.id)).toBe(true);
        store.redo();
        await a.flushed();
        expect(a.elements().some(e => e.id === edge.id)).toBe(false);
    });

    it('keeps layout and removal local to one view; undo restores its card without changing the instance', async () => {
        const a = await client(store, first), b = await client(store, second);
        const before = a.elements().find(e => key(e) === instance)!;
        edit({ kind: 'setBounds', view: first, bounds: [{ id: instance, x: 900, width: 450 }] });
        await a.flushed();
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ position: { x: 900 }, size: { width: 450 } });
        edit({ kind: 'removeFromView', view: first, ids: [instance] });
        await a.flushed();
        expect(a.elements()).toEqual([]);
        expect(docOf(store).instances[instance].label).toBe('Shared');
        store.undo();
        store.undo();
        await a.flushed();
        expect(a.elements().find(e => key(e) === instance)).toEqual(before);
        expect(b.refresh).not.toHaveBeenCalled();
        expect(b.elements().map(key)).toEqual([instance]);
    });

    it('moves a group and its contents as one undoable edit without moving the same instance in another view', async () => {
        const group = edit({ kind: 'createGroup', view: first, label: 'Group', rect: { x: -200, y: -200, width: 1000, height: 1000 } });
        const note = edit({ kind: 'createNote', view: first, text: 'Inside', at: { x: 100, y: 500 } });
        const a = await client(store, first), b = await client(store, second);
        const before = a.elements();
        edit({ kind: 'setBounds', view: first, bounds: [{ id: group, x: -120, y: -160 }] });
        await a.flushed();
        for (const id of [group, instance, note]) {
            const old = before.find(e => key(e) === id)! as GNodeSchema;
            expect(a.elements().find(e => key(e) === id)).toMatchObject({ position: { x: old.position!.x + 80, y: old.position!.y + 40 } });
        }
        store.undo();
        await a.flushed();
        expect(a.elements()).toEqual(before);
        edit({ kind: 'setBounds', view: first, bounds: [{ id: group, x: 80, y: 40, width: 600 }] });
        await a.flushed();
        // Resizing a group changes containment, not the positions of its contents.
        for (const id of [instance, note]) expect(a.elements().find(e => key(e) === id)).toEqual(before.find(e => key(e) === id));
        expect(b.refresh).not.toHaveBeenCalled();
    });

    it('law_layoutChangeReadsNoView, law_layoutChangeStaysInView: a move updates the kept part without a view read and leaves other views alone', async () => {
        const a = await client(store, first), b = await client(store, second);
        const quads = (store as unknown as { graph: { store: { select: unknown; construct: unknown } } }).graph.store;
        const read = vi.spyOn(store, 'viewDoc'), select = vi.spyOn(quads, 'select' as never), construct = vi.spyOn(quads, 'construct' as never);
        const card = { ...cardOf(a.state.view, instance)! };
        edit({ kind: 'setBounds', view: first, bounds: [{ id: card.id, x: 310, y: 420, width: 500 }] });
        await a.flushed();
        expect(a.sent.some(UpdateModelAction.is)).toBe(true);
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ position: { x: 310, y: 420 }, size: { width: 500 } });
        expect(cardOf(a.state.view, instance)).toMatchObject({ x: 310, y: 420, width: 500 });
        expect(read).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
        expect(construct).not.toHaveBeenCalled();
        // The other view shows the same instance: its placement did not change.
        expect(b.refresh).not.toHaveBeenCalled();
        expect(b.sent).toEqual([]);
        store.undo();
        await a.flushed();
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ position: { x: card.x, y: card.y }, size: { width: card.width } });
        expect(read).not.toHaveBeenCalled();
        expect(b.refresh).not.toHaveBeenCalled();
        // The style of a card and the sides of an edge are layout too.
        edit({ kind: 'setViewElements', view: first, ids: [card.id], patch: { display: 'simple', color: '#ff0000' } });
        await a.flushed();
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ display: 'simple', color: '#ff0000' });
        expect(read).not.toHaveBeenCalled();
        // A change of the content of a card re-reads that card only (the DataPatch tier, §11.3).
        edit({ kind: 'rename', id: instance, label: 'Content' });
        await a.flushed();
        expect(read).not.toHaveBeenCalled();
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ name: 'Content' });
    });

    it('tierOf DataPatch: a rename of one card reads that element with the scoped read, not the view', async () => {
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other', view: first, at: { x: 700, y: 200 } });
        const a = await client(store, first), b = await client(store, second);
        const read = vi.spyOn(store, 'viewDoc'), scoped = vi.spyOn(store as unknown as { scoped(scope: unknown): unknown }, 'scoped');
        edit({ kind: 'rename', id: instance, label: 'Renamed' });
        await Promise.all([a.flushed(), b.flushed()]);
        expect(read).not.toHaveBeenCalled();
        // One scoped read per canvas that shows the card, of that element only.
        expect(scoped).toHaveBeenCalledTimes(2);
        for (const call of scoped.mock.calls) expect(call[0]).toEqual({ elements: [instance], neighbors: true });
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ name: 'Renamed' });
        expect(b.elements().find(e => key(e) === instance)).toMatchObject({ name: 'Renamed' });
        expect(a.elements().find(e => key(e) === other)).toMatchObject({ name: 'Other' });
        expect(a.state.part.instances[instance].label).toBe('Renamed');
    });

    it('law_keptDocEqualsRead: the kept part equals a fresh read of the view after each change of a sequence', async () => {
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other', view: first, at: { x: 700, y: 200 } });
        const shape = edit({ kind: 'createNodeShape', label: 'Class shape', targetClass: 'urn:Class' });
        edit({ kind: 'createPropertyShape', shape, path: { kind: 'iri', iri: 'urn:p' }, range: { kind: 'class', class: 'urn:Class' } });
        const a = await client(store, first), b = await client(store, second);
        const otherUri = docOf(store).instances[other].uri;
        // What toSchema reads: the boxes, edges and arrows of the view, the label, types and fields of the instances, the relations.
        const shown = (doc: Doc, viewId: string) => {
            const view = doc.views[viewId];
            const ids = new Set([...boxes(view, 'card').map(c => c.element), ...boxes(view, 'collection').flatMap(c => c.members)]);
            return {
                boxes: view.boxes, edges: view.edges, arrows: view.arrows, label: view.label,
                instances: Object.fromEntries([...ids].filter(id => doc.instances[id]).map(id => { const { label, types, fields } = doc.instances[id]; return [id, { label, types, fields }]; })),
                relations: Object.values(doc.relations).filter(r => ids.has(r.subject) && ids.has(r.object)).sort((x, y) => x.id.localeCompare(y.id))
            };
        };
        const check = async (step: string) => {
            await Promise.all([a.flushed(), b.flushed()]);
            for (const [c, viewId] of [[a, first], [b, second]] as const) expect(shown(c.state.part, viewId), `${step}: ${viewId}`).toEqual(shown(store.viewDoc(viewId), viewId));
        };
        const steps: [string, () => void][] = [
            ['move', () => edit({ kind: 'setBounds', view: first, bounds: [{ id: cardOf(a.state.view, instance)!.id, x: 50, y: 60 }] })],
            ['rename', () => edit({ kind: 'rename', id: instance, label: 'Renamed' })],
            ['setStatements relation', () => edit({ kind: 'setStatements', id: instance, values: { 'urn:p': [{ termType: 'NamedNode', value: otherUri }] } })],
            ['setStatements field', () => edit({ kind: 'setStatements', id: other, values: { 'urn:note': [{ termType: 'Literal', value: 'text' }] } })],
            ['removeFromView', () => edit({ kind: 'removeFromView', view: first, ids: [other] })],
            ['addToView', () => edit({ kind: 'addToView', view: second, ids: [other], at: { x: 100, y: 900 } })],
            ['setStatements removes relation', () => edit({ kind: 'setStatements', id: instance, values: { 'urn:p': [] } })],
            ['undo', () => store.undo()], ['undo', () => store.undo()], ['undo', () => store.undo()], ['undo', () => store.undo()],
            ['redo', () => store.redo()], ['redo', () => store.redo()],
            ['rename other', () => edit({ kind: 'rename', id: other, label: 'Other again' })]
        ];
        const loads = [vi.spyOn(a.state, 'load'), vi.spyOn(b.state, 'load')];
        for (const [step, run] of steps) { run(); await check(step); }
        // Only a placement change of its own view reads a view again. First: the relation arrives as a placed edge, removeFromView, its
        // undo and its redo. Second: addToView, the cascade of the relation removal on its placed edge, their undo. The move, the renames,
        // the field edit and their undo and redo read no view.
        expect(loads.map(l => l.mock.calls.length)).toEqual([4, 4]);
    });

    it('law_keptDocEqualsRead: a note whose statements live in a data file shows its edited text (a DataPatch on a placed mark reads the view again)', async () => {
        const note = edit({ kind: 'createNote', view: first, text: 'Old text', at: { x: -600, y: 0 } });
        // Move the statements of the note from the view graph into the data graph (a file can hold marks: readView reads marks in any graph).
        const g = (store as unknown as { graph: ModelGraph }).graph;
        const dataGraph = g.dataGraphs()[0], viewGraph = rdf.namedNode(docOf(store).views[first].uri);
        const mark = g.match(null, rdf.namedNode(NS.view + 'element'), null, viewGraph).map(q => q.object).find(o => g.match(o as never, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'Note')).length)!;
        g.transact(x => {
            for (const q of x.match(mark as never, null, null, viewGraph)) { x.remove(q); x.add(q.subject, q.predicate, q.object, dataGraph); }
            return { ok: true };
        });
        expect(g.match(mark as never, null, null, dataGraph).length).toBeGreaterThan(0);
        const a = await client(store, first);
        expect(a.elements().find(e => e.id === note)).toMatchObject({ text: 'Old text' });
        const read = vi.spyOn(store, 'viewDoc');
        edit({ kind: 'setViewElements', view: first, ids: [note], patch: { text: 'New text' } });
        expect(store.snapshot().change).toMatchObject({ reason: 'edit', tier: 'data', elements: [elementId(mark as never)] });
        await a.flushed();
        expect(read).toHaveBeenCalledTimes(1);
        expect(a.elements().find(e => e.id === note)).toMatchObject({ text: 'New text' });
        expect(a.state.view!.boxes).toEqual(store.viewDoc(first).views[first].boxes);
    });

    it('a validation run refreshes the counts on the cards without a view read', async () => {
        const a = await client(store, first);
        const shape = edit({ kind: 'createNodeShape', label: 'Class shape', targetClass: 'urn:Class' });
        edit({ kind: 'createPropertyShape', shape, path: { kind: 'iri', iri: 'urn:name' }, range: { kind: 'datatype', datatype: 'http://www.w3.org/2001/XMLSchema#string' }, minCount: 1 });
        await a.flushed();
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ violations: 0 });
        a.refresh.mockClear();
        const read = vi.spyOn(store, 'viewDoc');
        const reasons: string[] = [];
        store.onDidChange(e => reasons.push(e.reason));
        await store.validate();
        expect(reasons).toEqual(['validation']);
        await a.flushed();
        expect(a.refresh).toHaveBeenCalledTimes(1);
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ violations: 1 });
        expect(read).not.toHaveBeenCalled();
    });

    it('shows an edge removal and a later move together after one refresh of a hidden canvas', async () => {
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other', view: first, at: { x: 700, y: 200 } });
        const shape = edit({ kind: 'createNodeShape', label: 'Class shape', targetClass: 'urn:Class' });
        edit({ kind: 'createPropertyShape', shape, path: { kind: 'iri', iri: 'urn:p' }, range: { kind: 'class', class: 'urn:Class' } });
        edit({ kind: 'setStatements', id: instance, values: { 'urn:p': [{ termType: 'NamedNode', value: docOf(store).instances[other].uri }] } });
        const a = await client(store, first);
        const edge = a.state.view!.edges.find(e => e.id)!;
        const card = a.elements().find(e => key(e) === instance) as GNodeSchema;
        await a.session.setVisible(false);
        edit({ kind: 'removeFromView', view: first, ids: [edge.id!] });
        edit({ kind: 'setBounds', view: first, bounds: [{ id: card.id, x: 1234, y: 567 }] });
        expect(a.sent.filter(UpdateModelAction.is)).toHaveLength(0);
        await a.session.setVisible(true);
        expect(a.sent.filter(UpdateModelAction.is)).toHaveLength(1);
        expect(a.elements().some(e => e.id === edge.id)).toBe(false);
        expect((a.elements().find(e => key(e) === instance) as GNodeSchema).position).toEqual({ x: 1234, y: 567 });
    });

    it('shows a move and a later edge removal together after one refresh of a hidden canvas', async () => {
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other', view: first, at: { x: 700, y: 200 } });
        const shape = edit({ kind: 'createNodeShape', label: 'Class shape', targetClass: 'urn:Class' });
        edit({ kind: 'createPropertyShape', shape, path: { kind: 'iri', iri: 'urn:p' }, range: { kind: 'class', class: 'urn:Class' } });
        edit({ kind: 'setStatements', id: instance, values: { 'urn:p': [{ termType: 'NamedNode', value: docOf(store).instances[other].uri }] } });
        const a = await client(store, first);
        const edge = a.state.view!.edges.find(e => e.id)!;
        const card = a.elements().find(e => key(e) === instance) as GNodeSchema;
        await a.session.setVisible(false);
        edit({ kind: 'setBounds', view: first, bounds: [{ id: card.id, x: 1234, y: 567 }] });
        edit({ kind: 'removeFromView', view: first, ids: [edge.id!] });
        await a.session.setVisible(true);
        expect(a.sent.filter(UpdateModelAction.is)).toHaveLength(1);
        expect(a.elements().some(e => e.id === edge.id)).toBe(false);
        expect((a.elements().find(e => key(e) === instance) as GNodeSchema).position).toEqual({ x: 1234, y: 567 });
    });

    it('law_revealAfterShowUpdate: the show of a hidden canvas answers with the revision of its update; a move while hidden is in it', async () => {
        const a = await client(store, first);
        const card = a.elements().find(e => key(e) === instance) as GNodeSchema;
        const handler = Object.assign(new SetVisibleHandler(), { session: a.session });
        await handler.execute({ kind: SetVisibleAction.KIND, visible: false } as Action);
        edit({ kind: 'setBounds', view: first, bounds: [{ id: card.id, x: 1234, y: 567 }] });
        const [answer] = await handler.execute({ kind: SetVisibleAction.KIND, visible: true, requestId: 'r1' } as Action) as VisibleSetAction[];
        const update = a.sent.filter(UpdateModelAction.is);
        expect(update).toHaveLength(1);
        expect(answer).toEqual({ kind: VisibleSetAction.KIND, responseId: 'r1', revision: update[0].newRoot.revision });
        expect((update[0].newRoot.children!.find(e => key(e) === instance) as GNodeSchema).position).toEqual({ x: 1234, y: 567 });
        // Nothing changed: the answer gives the revision that the client has, and no update.
        expect(await handler.execute({ kind: SetVisibleAction.KIND, visible: true, requestId: 'r2' } as Action)).toEqual([{ kind: VisibleSetAction.KIND, responseId: 'r2', revision: update[0].newRoot.revision }]);
        expect(await handler.execute({ kind: SetVisibleAction.KIND, visible: false } as Action)).toEqual([]);
        expect(a.sent.filter(UpdateModelAction.is)).toHaveLength(1);
    });

    it('law_hiddenCanvasRefreshesOnce: a hidden canvas collects changes and gets one update when it is shown', async () => {
        const a = await client(store, first);
        await a.session.setVisible(false);
        edit({ kind: 'rename', id: instance, label: 'First change' });
        edit({ kind: 'rename', id: instance, label: 'Second change' });
        expect(a.refresh).not.toHaveBeenCalled();
        expect(a.sent).toEqual([]);
        await a.session.setVisible(true);
        expect(a.refresh).toHaveBeenCalledTimes(1);
        expect(a.sent.filter(UpdateModelAction.is)).toHaveLength(1);
        expect(a.elements().find(e => key(e) === instance)).toMatchObject({ name: 'Second change' });
        await a.session.setVisible(true);
        expect(a.refresh).toHaveBeenCalledTimes(1);
        // Its own edit is sent while hidden; nothing is due at the next show.
        await a.session.setVisible(false);
        a.sent.length = 0;
        await a.session.edit({ kind: 'rename', id: instance, label: 'Own edit' });
        expect(a.sent.filter(UpdateModelAction.is)).toHaveLength(1);
        await a.session.setVisible(true);
        expect(a.refresh).toHaveBeenCalledTimes(1);
    });

    it('sends one update before follow-up selection, and rejects invalid edits without a selection or model change', async () => {
        const a = await client(store, first);
        const select = vi.fn(() => [{ kind: 'select', selectedElementsIDs: [instance] }]);
        await a.session.edit({ kind: 'rename', id: instance, label: 'Changed' }, select);
        expect(a.sent.map(a => a.kind)).toEqual(['updateModel', 'setDirtyState', 'select']);
        expect(a.refresh).not.toHaveBeenCalled(); // The originating session must not echo its own edit.
        a.sent.length = 0;
        select.mockClear();
        const before = store.snapshot();
        const logged = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
        await a.session.edit({ kind: 'rename', id: instance, label: ' invalid' }, select);
        // law_canvasEditErrorsOnce: one warning with the command kind and the reason, then the model of the store; no log line.
        expect(a.sent.filter(MessageAction.is)).toHaveLength(1);
        expect(a.sent[0]).toMatchObject({ kind: MessageAction.KIND, severity: 'WARNING', message: expect.stringMatching(/^"rename" refused: .+/) });
        expect(a.sent.some(UpdateModelAction.is)).toBe(true);
        expect(logged.map(l => l.mock.calls.length)).toEqual([0, 0]);
        expect(select).not.toHaveBeenCalled();
        expect(store.snapshot()).toEqual(before);
    });

    it('law_canvasEditErrorsOnce: a handler whose edit throws or is refused sends one warning and returns no GLSP command', async () => {
        const a = await client(store, first);
        const logged = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
        const execute = vi.spyOn(store, 'execute').mockImplementation(() => { throw new Error('The model index failed.'); });
        const remove = Object.assign(new DeleteHandler(), { session: a.session });
        const card = cardOf(a.state.view, instance)!;
        expect(await remove.createCommand(DeleteElementOperation.create([card.id]))).toBeUndefined();
        expect(a.sent).toEqual([expect.objectContaining({ kind: MessageAction.KIND, severity: 'WARNING', message: '"removeFromView" failed in the backend: The model index failed.' })]);
        a.sent.length = 0;
        execute.mockImplementation(() => ({ ok: false, error: 'The store refused it.' }));
        const move = Object.assign(new ChangeBoundsHandler(), { session: a.session });
        expect(await move.createCommand(ChangeBoundsOperation.create([{ elementId: card.id, newPosition: { x: 1, y: 2 }, newSize: { width: 300, height: 200 } }]))).toBeUndefined();
        expect(a.sent.filter(MessageAction.is)).toEqual([expect.objectContaining({ severity: 'WARNING', message: '"setBounds" refused: The store refused it.' })]);
        expect(a.sent.some(UpdateModelAction.is)).toBe(true);
        expect(logged.map(l => l.mock.calls.length)).toEqual([0, 0]);
    });

    it('fits only arriving cut placements while selecting existing cards too (UI §7.5)', async () => {
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other', view: first, at: { x: 700, y: 200 } });
        edit({ kind: 'setBounds', view: second, bounds: [{ id: instance, x: 20000, y: 20000 }] });
        const existing = cardOf(docOf(store).views[second], instance)!;
        const clip = copyFromView(docOf(store), first, [instance, other], 'cut')!;
        const c = await client(store, second);
        const handler = Object.assign(new PasteHandler(), { session: c.session });
        await handler.createCommand(PasteOperation.create({
            clipboardData: { [VIEW_CLIP_FORMAT]: JSON.stringify(clip) },
            editorContext: { selectedElementIds: [], lastMousePosition: { x: 0, y: 0 } }
        }));
        const arriving = cardOf(docOf(store).views[second], other)!;
        expect(c.sent.find(SelectAction.is)).toMatchObject({ selectedElementsIDs: expect.arrayContaining([existing.id, arriving.id]) });
        expect(c.sent.find(FitToScreenAction.is)).toMatchObject({ elementIds: [arriving.id] });
        expect(cardOf(docOf(store).views[second], instance)).toEqual(existing);
    });

    it('the paste reply carries the counts: placed, skipped (already in the view), missing from this model (UI §5.8)', async () => {
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other', view: first, at: { x: 700, y: 200 } });
        const gone = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Gone', view: first, at: { x: 900, y: 200 } });
        const clip = copyFromView(docOf(store), first, [instance, other, gone], 'copy')!;
        edit({ kind: 'delete', ids: [gone] });
        const c = await client(store, second);
        const handler = Object.assign(new PasteHandler(), { session: c.session });
        const paste = (data: unknown, extra: Record<string, string> = {}) => handler.createCommand(PasteOperation.create({
            clipboardData: { [VIEW_CLIP_FORMAT]: JSON.stringify(data), ...extra },
            editorContext: { selectedElementIds: [], lastMousePosition: { x: 0, y: 0 } }
        }));
        await paste(clip);
        expect(c.sent.filter(a => a.kind === PASTE_RESULT)).toEqual([{ kind: PASTE_RESULT, mode: 'copy', placed: 1, skipped: 1, missing: 1, alreadyInView: false }]);
        // A cut clip that the view shows completely: no command, the reply only. The reply names the clip of the cut.
        c.sent.length = 0;
        const before = store.snapshot();
        await paste(copyFromView(docOf(store), first, [instance, other], 'cut')!, { clipboardId: 'clip-1' });
        expect(c.sent).toEqual([{ kind: PASTE_RESULT, mode: 'cut', placed: 0, skipped: 2, missing: 0, alreadyInView: true, clipboardId: 'clip-1' }]);
        expect(store.snapshot()).toEqual(before);
        expect(cardOf(docOf(store).views[first], instance)).toBeDefined();
    });

    it('fits the cards that a cut and paste re-places within one view (UI §7.5)', async () => {
        const clip = copyFromView(docOf(store), first, [instance], 'cut')!;
        const a = await client(store, first);
        const handler = Object.assign(new PasteHandler(), { session: a.session });
        await handler.createCommand(PasteOperation.create({
            clipboardData: { [VIEW_CLIP_FORMAT]: JSON.stringify(clip) },
            editorContext: { selectedElementIds: [], lastMousePosition: { x: 30000, y: 30000 } }
        }));
        const moved = cardOf(docOf(store).views[first], instance)!;
        expect([moved.x, moved.y]).toEqual([30000, 30000]);
        expect(a.sent.find(FitToScreenAction.is)).toMatchObject({ elementIds: [moved.id] });
    });

    it('updates a reference when the target view is renamed or deleted, including undo', async () => {
        const reference = edit({ kind: 'addViewReference', view: first, target: second, at: { x: 0, y: 0 } });
        const a = await client(store, first);
        edit({ kind: 'rename', id: second, label: 'Renamed target' });
        await a.flushed();
        expect(a.elements().find(e => e.id === reference)).toMatchObject({ name: 'Renamed target', targetViewId: second });
        edit({ kind: 'delete', ids: [second] });
        await a.flushed();
        expect(a.elements().find(e => e.id === reference)).toBeUndefined();
        store.undo();
        await a.flushed();
        expect(a.elements().find(e => e.id === reference)).toMatchObject({ name: 'Renamed target' });
    });

    it('sends an error thrown by an edit to the client as one warning, without a model (§3.4)', async () => {
        const a = await client(store, first);
        vi.spyOn(store, 'execute').mockImplementation(() => { throw new Error('The model index failed. The files are read again.'); });
        const logged = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
        await a.session.edit({ kind: 'removeFromView', view: first, ids: [instance] });
        expect(a.sent).toHaveLength(1);
        expect(a.sent[0]).toMatchObject({ kind: MessageAction.KIND, severity: 'WARNING', message: '"removeFromView" failed in the backend: The model index failed. The files are read again.' });
        expect(logged.map(l => l.mock.calls.length)).toEqual([0, 0]);   // law_canvasEditErrorsOnce: nothing is logged twice
    });

    it('clears dirty state on save and stops sending updates after the client disconnects', async () => {
        const a = await client(store, first), b = await client(store, second);
        edit({ kind: 'rename', id: instance, label: 'Saved' });
        await Promise.all([a.flushed(), b.flushed()]);
        for (const c of [a, b]) expect(c.sent.at(-1)).toMatchObject({ kind: 'setDirtyState', isDirty: true });
        expect(await store.save()).toEqual({ ok: true });
        for (const c of [a, b]) expect(c.sent.at(-1)).toMatchObject({ kind: 'setDirtyState', isDirty: false });
        a.dispose();
        a.sent.length = 0;
        edit({ kind: 'rename', id: instance, label: 'Still connected' });
        await b.flushed();
        expect(a.sent).toEqual([]);
        expect(b.elements().find(e => key(e) === instance)).toMatchObject({ name: 'Still connected' });
    });
});

describe('law_clientGetsNoOlderModel: the backend sends no model older than one it sent (ui-manifest §3.2, open.md MOVE1)', () => {
    it('drops a refresh model that leaves the queue after the newer model of an edit; the next refresh is sent', async () => {
        const c = await queuedClient(store, first);
        const card = cardOf(docOf(store).views[first], instance)!;
        expect(c.received.filter(SetModelAction.is).map(a => a.newRoot.revision)).toEqual([0]);
        // A handler waits (the queue is busy across a macrotask). A store change builds a refresh model behind a queued move.
        const waiting = c.wait();
        await macrotask();
        edit({ kind: 'rename', id: instance, label: 'Renamed' });
        const moved = c.move({ kind: 'setBounds', view: first, bounds: [{ id: card.id, x: 1234, y: 567 }] });
        await macrotask();
        await macrotask();
        expect(c.refresh).toHaveBeenCalledTimes(1);
        expect(c.modelState.root.revision).toBe(1);   // the refresh model is built (revision 1) and waits in the queue
        expect(c.updates()).toEqual([]);
        c.release();
        await Promise.all([waiting, moved, c.flushed()]);
        // The edit sent revision 2 with the new bounds. The refresh model (revision 1, old bounds) is dropped.
        expect(c.updates().map(u => u.newRoot.revision)).toEqual([2]);
        const shown = c.updates()[0].newRoot.children!.find(e => key(e) === instance) as GNodeSchema;
        expect(shown).toMatchObject({ name: 'Renamed', position: { x: 1234, y: 567 } });
        edit({ kind: 'rename', id: instance, label: 'Again' });
        await c.flushed();
        expect(c.updates().map(u => u.newRoot.revision)).toEqual([2, 3]);
        expect(c.updates()[1].newRoot.children!.find(e => key(e) === instance)).toMatchObject({ name: 'Again' });
        c.dispose();
    });

    it('sends a refresh when no newer model was sent', async () => {
        const c = await queuedClient(store, first);
        edit({ kind: 'rename', id: instance, label: 'Renamed' });
        await c.flushed();
        expect(c.updates().map(u => u.newRoot.revision)).toEqual([1]);
        expect(c.updates()[0].newRoot.children!.find(e => key(e) === instance)).toMatchObject({ name: 'Renamed' });
        expect(c.received.filter(SetDirtyStateAction.is)).toHaveLength(2);   // the initial model and the refresh
        c.dispose();
    });
});
