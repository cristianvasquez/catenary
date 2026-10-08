import { expect, it, vi } from 'vitest';
import { CommandResult, EditCommand, Migration, ModelSelection, NewLabelKind, Range, emptyDoc, emptySelected, newLabel } from '@catenary/model';
import { ModelActions } from '../src/browser/actions';
import { viewAsItem } from '../src/browser/action-service';
import { SelectionModel } from '../src/browser/selection-model';

// Keep the action logic in Node; these browser-only modules supply DI tokens, not behavior under test.
vi.mock('@theia/core/lib/browser', () => ({ ConfirmDialog: class {}, SingleTextInputDialog: class {} }));
vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {} }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class {} }));
vi.mock('../src/browser/diagram/view-editors', () => ({ ViewEditors: class {} }));
vi.mock('../src/browser/follow-up', () => ({ FollowUp: class {} }));

/** A SelectionModel on a fake backend that resolves every id as it is. */
function selectionModel(): SelectionModel {
    const model = {
        snapshot: { revision: 0 }, isOpen: true, onDidChange: () => ({ dispose() {} }),
        service: { selected: async (s: ModelSelection) => ({ ...emptySelected(), view: s.view, ids: s.ids, elements: s.ids }) }
    };
    return Object.assign(new SelectionModel(), { model });
}

const migration = (id: string): Migration => ({ id, kind: 'renameClass', from: 'urn:Old', to: 'urn:New', reason: id, count: 2 });

function fixture(result: CommandResult = { ok: true, id: 'changed' }) {
    const snapshot = { migrations: [migration('existing')] };
    const execute = vi.fn(async (_command: EditCommand) => {
        if (result.ok) snapshot.migrations = [...snapshot.migrations, migration('new')];
        return result;
    });
    const widget = {};
    const editors = { find: vi.fn(() => widget), whenShown: vi.fn(async () => {}) };
    const selection = selectionModel();
    const messages = { info: vi.fn(async (): Promise<string | undefined> => 'Later') };
    const actions = Object.assign(new ModelActions(), { model: { snapshot, execute }, editors, selection, messages });
    return { actions, execute, editors, selection, messages, widget };
}

const range: Range = { kind: 'scheme', schemes: ['urn:scheme'] };
const at = { x: 300, y: 200 };
const patch = { path: { kind: 'iri', iri: 'urn:newPath' } } as const;

type ActionKind = 'property' | 'range' | 'node';
function edit(actions: ModelActions, kind: ActionKind, view?: string): Promise<unknown> {
    if (kind === 'property') return actions.setProperty('p', patch, view);
    if (kind === 'range') return actions.setRange('p', range, view, at);
    return actions.setNodeShape('s', { targetClass: 'urn:New' });
}

it.each<[ActionKind, string | undefined]>([
    ['property', undefined], ['property', 'view'], ['range', undefined], ['range', 'view'], ['node', undefined]
])('%s edit (view=%s) preserves command fields, result, selection, and new migration notifications', async (kind, view) => {
    const { actions, execute, editors, selection, messages, widget } = fixture();
    const result = await edit(actions, kind, view);
    const command: EditCommand = kind === 'property' ? { kind: 'setPropertyShape', id: 'p', patch }
        : kind === 'range' ? { kind: 'setPropertyShape', id: 'p', patch: { range }, view, at }
        : { kind: 'setNodeShape', id: 's', patch: { targetClass: 'urn:New' } };
    expect(execute.mock.calls).toStrictEqual([[command]]);
    expect(result).toBe(kind === 'property' ? 'changed' : undefined);
    if (view) {
        expect(editors.find).toHaveBeenCalledWith(view);
        expect(editors.whenShown).toHaveBeenCalledWith(widget, ['changed']);
        expect(selection.selection).toEqual({ view, ids: ['changed'] });
    } else {
        expect(editors.find).not.toHaveBeenCalled();
        expect(editors.whenShown).not.toHaveBeenCalled();
        expect(selection.selection.ids).toEqual([]);
    }
    expect(messages.info.mock.calls).toEqual([['new. 2 data statement(s) use the old term.', 'Apply to data', 'Later']]);
});

it.each<ActionKind>(['property', 'range', 'node'])('failed %s edit does not select or offer migrations', async kind => {
    const { actions, execute, editors, selection, messages } = fixture({ ok: false, error: 'Rejected' });
    expect(await edit(actions, kind, 'view')).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(editors.whenShown).not.toHaveBeenCalled();
    expect(selection.selection.ids).toEqual([]);
    expect(messages.info).not.toHaveBeenCalled();
});

it('does not offer existing migrations again when the edit adds none', async () => {
    const { actions, execute, messages } = fixture();
    execute.mockResolvedValue({ ok: true, id: 'unchanged' });
    expect(await actions.setProperty('p', patch)).toBe('unchanged');
    expect(messages.info).not.toHaveBeenCalled();
});

it('waits for the edited element to render before selecting it or offering migrations', async () => {
    const { actions, editors, selection, messages } = fixture();
    let shown!: () => void;
    const rendering = new Promise<void>(resolve => { shown = resolve; });
    let waiting!: () => void;
    const started = new Promise<void>(resolve => { waiting = resolve; });
    editors.whenShown.mockImplementation(() => { waiting(); return rendering; });
    const pending = actions.setProperty('p', patch, 'view');
    await started;
    expect(selection.selection.ids).toEqual([]);
    expect(messages.info).not.toHaveBeenCalled();
    shown();
    expect(await pending).toBe('changed');
    expect(selection.selection).toEqual({ view: 'view', ids: ['changed'] });
    expect(messages.info).toHaveBeenCalledTimes(1);
});

it('does not wait for a migration notification response before returning the edit result', async () => {
    const { actions, messages } = fixture();
    messages.info.mockReturnValue(new Promise(() => {}));
    expect(await actions.setProperty('p', patch)).toBe('changed');
    expect(messages.info).toHaveBeenCalledTimes(1);
});

it.each([['/w/project', '/w/project'], ['/w/project.trig', '/w/project']])('New Workspace %s asks the placement, then creates %s.trig with it', async (typed, base) => {
    const create = vi.fn(async () => ({ ok: true }));
    const actions = Object.assign(new ModelActions(), {
        model: { snapshot: { dirty: false }, service: { create }, report: async (p: Promise<unknown>) => (await p, false) },
        fileDialog: { showSaveDialog: async () => ({ path: { fsPath: () => typed } }) },
        workspaceService: { roots: Promise.resolve([]) }
    });
    vi.spyOn(actions as unknown as { workspaceRoot: () => Promise<undefined> }, 'workspaceRoot').mockResolvedValue(undefined);
    const placement = { shapes: 'project.shapes.ttl', concepts: 'near', instances: 'near' };
    const ask = vi.spyOn(actions as unknown as { askPlacement: (name: string) => Promise<unknown> }, 'askPlacement').mockResolvedValueOnce(placement).mockResolvedValueOnce(undefined);
    await actions.newModel();
    expect(ask.mock.calls).toEqual([['project']]);
    expect(create.mock.calls).toEqual([[`${base}.trig`, placement]]);
    // Cancel in the dialog: nothing is created.
    await actions.newModel();
    expect(create).toHaveBeenCalledTimes(1);
});

it('viewAsItem: an empty selection on a canvas is its view for Go to Source only', () => {
    expect(viewAsItem('catenary.goToSource', { view: 'v', ids: [], activeView: 'v' })).toEqual({ ids: ['v'], activeView: 'v' });
    expect(viewAsItem('catenary.goToSource', { view: 'v', ids: ['c'] })).toEqual({ view: 'v', ids: ['c'] });
    expect(viewAsItem('catenary.deleteFromModel', { view: 'v', ids: [] })).toEqual({ view: 'v', ids: [] });
    expect(viewAsItem('catenary.goToSource', { ids: [] })).toEqual({ ids: [] });
});

it('Propose Missing Shapes shows the new shapes in a new view: free label, cards, Layered layout, fit, selection', async () => {
    const dispatch = vi.fn(async () => {});
    const widget = { actionDispatcher: { onceModelInitialized: vi.fn(async () => {}), dispatch } };
    const calls: string[] = [];
    const editors = {
        open: vi.fn(async () => widget), find: vi.fn(() => widget), center: vi.fn(() => at),
        whenShown: vi.fn(async () => {}), whenChanged: vi.fn(async () => { calls.push('changed'); }), fit: vi.fn(async () => { calls.push('fit'); })
    };
    const execute = vi.fn(async (c: EditCommand): Promise<CommandResult> =>
        c.kind === 'proposeShapes' ? { ok: true, ids: ['s1', 's2'] } : c.kind === 'createView' ? { ok: true, id: 'v' } : { ok: true });
    const selection = selectionModel();
    // The backend gives the label of the new view: "proposed shapes" is taken.
    const doc = emptyDoc();
    doc.views.old = { id: 'old', uri: 'urn:old', label: 'proposed shapes', boxes: [], edges: [], arrows: [] };
    const service = { newLabel: async (kind: NewLabelKind, opts?: { base?: string }) => newLabel(doc, { classes: [] }, kind, opts) };
    const actions = Object.assign(new ModelActions(), {
        model: { snapshot: { migrations: [] }, execute, service },
        editors, selection, messages: { info: vi.fn() }, layoutPreferences: { spacing: 120 }
    });
    await actions.proposeShapes();
    expect(execute.mock.calls.map(c => c[0])).toStrictEqual([
        { kind: 'proposeShapes', classes: undefined },
        { kind: 'createView', label: 'proposed shapes 2' },
        { kind: 'addToView', view: 'v', ids: ['s1', 's2'], at }
    ]);
    expect(dispatch).toHaveBeenCalledWith({ kind: 'catenaryLayoutView', algorithm: 'layered', spacing: 120 });
    expect(calls).toEqual(['changed', 'fit']);
    expect(selection.selection).toEqual({ view: 'v', ids: ['s1', 's2'] });
});

it('openView: a view of the open workspace opens; else its workspace opens first; a view in no workspace gives a message', async () => {
    const labels: Record<string, string> = { here: 'Here' };
    const open = vi.fn(async (file: string) => { labels.far = 'Far'; return { ok: true, file }; });
    const model = {
        isOpen: true, snapshot: { file: '/ws/workspace.trig', dirty: false },
        service: { viewLabels: async () => ({ ...labels }), open },
        report: async (p: Promise<CommandResult>) => (await p).ok
    };
    const editors = { open: vi.fn(async () => ({})) };
    const messages = { warn: vi.fn() };
    const actions = Object.assign(new ModelActions(), { model, editors, messages });
    await actions.openView('here', '/ws/workspace.trig');
    expect(open).not.toHaveBeenCalled();
    expect(editors.open).toHaveBeenLastCalledWith('here');
    await actions.openView('far', '/other/workspace.trig');
    expect(open).toHaveBeenCalledWith('/other/workspace.trig');
    expect(editors.open).toHaveBeenLastCalledWith('far');
    await actions.openView('lone');
    expect(messages.warn).toHaveBeenCalledTimes(1);
    expect(editors.open).toHaveBeenCalledTimes(2);
});

it('New View: the file dialog is the only dialog; the view opens as "unnamed view N" with no label follow-up', async () => {
    const execute = vi.fn(async (_c: EditCommand): Promise<CommandResult> => ({ ok: true, id: 'v' }));
    const editors = { open: vi.fn(async () => ({})) };
    const follow = vi.fn();
    const actions = Object.assign(new ModelActions(), {
        model: { execute, service: { newLabel: async () => 'unnamed view 1' } }, editors,
        askViewFile: async () => 'views/road.trig', followUp: follow
    });
    await actions.newView();
    expect(execute).toHaveBeenCalledWith({ kind: 'createView', label: 'unnamed view 1', file: 'views/road.trig' });
    expect(editors.open).toHaveBeenCalledWith('v');
    expect(follow).not.toHaveBeenCalled();
});
