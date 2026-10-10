import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    Action, DefaultGModelSerializer, DefaultModelState, GModelIndex, ModelSubmissionHandler, UpdateModelAction, PasteOperation, FitToScreenAction, SelectAction
} from '@eclipse-glsp/server';
import { GNodeSchema } from '@eclipse-glsp/protocol';
import { EditCommand, cardOf, copyFromView, VIEW_CLIP_FORMAT } from '@catenary/model';

/** A diagram element by the id of what it shows: a card or a placed edge by its element (its id is the id of its placement). */
const key = (e: { id: string; element?: unknown }) => (e.element as string | undefined) ?? e.id;
import { ModelStore } from '@catenary/rdf';
import { ViewDiagramConfiguration } from '../src/node/glsp/diagram-module';
import { StoreCommandStack, ViewGModelFactory, ViewSession, ViewState } from '../src/node/glsp/view-session';
import { PasteHandler } from '../src/node/glsp/handlers';
import { docOf } from '../../packages/rdf/test/helpers';

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
    const session = Object.assign(new ViewSession(), { state, submission, dispatcher, sessions, clientId: viewId });
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
        // A change of the content of the view reads it again.
        edit({ kind: 'rename', id: instance, label: 'Content' });
        await a.flushed();
        expect(read).toHaveBeenCalledTimes(1);
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
        await a.session.edit({ kind: 'rename', id: instance, label: ' invalid' }, select);
        expect(a.sent[0]).toMatchObject({ kind: 'message', severity: 'WARNING' });
        expect(select).not.toHaveBeenCalled();
        expect(store.snapshot()).toEqual(before);
    });

    it('fits only arriving cut placements while selecting existing cards too (UI §7.5)', async () => {
        const other = edit({ kind: 'createInstance', classIri: 'urn:Class', label: 'Other', view: first, at: { x: 700, y: 200 } });
        edit({ kind: 'setBounds', view: second, bounds: [{ id: instance, x: 20000, y: 20000 }] });
        const existing = cardOf(docOf(store).views[second], instance)!;
        const clip = copyFromView(docOf(store), first, [instance, other], 'cut')!;
        edit({ kind: 'cutFromView', view: first, ids: [instance, other] });
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
