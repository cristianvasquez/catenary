import { afterEach, expect, it, vi } from 'vitest';
import type { ActionTarget, SelectionActions } from '@catenary/model';

vi.mock('../src/browser/model-client', () => ({ ModelFrontend: class {} }));
vi.mock('../src/browser/diagram/view-editors', () => ({ ViewEditors: class {} }));
vi.mock('../src/browser/selection-model', async importOriginal => ({ ...await importOriginal<object>(), SelectionModel: class {} }));

import { ActionService } from '../src/browser/action-service';
import { SELECTION_QUIET_MS } from '../src/browser/selection-model';

afterEach(() => vi.useRealTimers());
const settle = () => vi.advanceTimersByTimeAsync(0);
const answer = (label: string): SelectionActions => ({ actions: [{ id: label, enabled: true }], items: [], cards: [] }) as SelectionActions;

function fixture() {
    vi.useFakeTimers();
    let changed: (s: { change?: object }) => void = () => undefined;
    let selectionChanged: () => void = () => undefined;
    const replies: ((a: SelectionActions) => void)[] = [];
    const sent: ActionTarget[] = [];
    const model = {
        isOpen: true,
        onDidChange: (l: typeof changed) => { changed = l; return { dispose() {} }; },
        service: { selectionActions: (t: ActionTarget) => { sent.push(t); return new Promise<SelectionActions>(resolve => replies.push(resolve)); } }
    };
    const selection = { selection: { view: undefined, ids: ['i1'] } as { view?: string; ids: string[] }, onDidChange: (l: () => void) => { selectionChanged = l; return { dispose() {} }; } };
    const editors = { currentViewId: () => undefined, onDidChangeCurrentView: () => ({ dispose() {} }) };
    const service = Object.assign(new ActionService(), { model, selection, editors });
    (service as unknown as { init(): void }).init();
    const select = (ids: string[]) => { selection.selection = { view: undefined, ids }; selectionChanged(); };
    return { service, replies, sent, select, change: () => changed({ change: { reason: 'edit' } }) };
}

it('latest keeps the answer of the last revision until the new answer arrives; get does not', async () => {
    const { service, replies, change } = fixture();
    const target = service.selectionTarget();
    expect(service.get(target).actions).toEqual([]);
    vi.advanceTimersByTime(SELECTION_QUIET_MS);
    replies.shift()!(answer('a'));
    await settle();
    expect(service.get(target).actions.map(a => a.id)).toEqual(['a']);

    change();
    expect(service.get(target).actions).toEqual([]);
    expect(service.latest(target).actions.map(a => a.id)).toEqual(['a']);

    vi.advanceTimersByTime(SELECTION_QUIET_MS);
    replies.shift()!(answer('b'));
    await settle();
    expect(service.get(target).actions.map(a => a.id)).toEqual(['b']);
    expect(service.latest(target).actions.map(a => a.id)).toEqual(['b']);
});

it('law_selectionReadsLastOnly: a sequence of selection changes sends one read, of the last selection, after the quiet time', async () => {
    const { service, replies, sent, select } = fixture();
    select(['i1']);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(SELECTION_QUIET_MS);
    expect(sent.map(t => t.ids)).toEqual([['i1']]);
    select(['i1', 'i2']);
    vi.advanceTimersByTime(SELECTION_QUIET_MS - 1);
    select(['i1', 'i2', 'i3']);
    // The window selection asked by a key or a toolbar (get, latest) waits with the quiet time too.
    expect(service.get(service.selectionTarget()).actions).toEqual([]);
    expect(service.latest(service.selectionTarget()).actions).toEqual([]);
    vi.advanceTimersByTime(SELECTION_QUIET_MS - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent.map(t => t.ids)).toEqual([['i1'], ['i1', 'i2', 'i3']]);
    // The first answer arrives late: it is stored for its target, and the last selection has its own answer.
    replies[0](answer('first'));
    replies[1](answer('last'));
    await settle();
    expect(service.get({ ids: ['i1'] }).actions.map(a => a.id)).toEqual(['first']);
    expect(service.get(service.selectionTarget()).actions.map(a => a.id)).toEqual(['last']);
    expect(sent).toHaveLength(2);
});

it('an explicit target (a menu, a row) and fetch for a menu go at once', async () => {
    const { service, sent, select } = fixture();
    select(['i2']);
    expect(service.get({ ids: ['row'] }).actions).toEqual([]);
    expect(sent.map(t => t.ids)).toEqual([['row']]);
    void service.fetch(service.selectionTarget());
    expect(sent.map(t => t.ids)).toEqual([['row'], ['i2']]);
    vi.advanceTimersByTime(SELECTION_QUIET_MS);
    expect(sent).toHaveLength(2);
});

it('enabled: a command of the window selection can run before its answer arrives; after it, the answer decides', async () => {
    const { service, replies, select } = fixture();
    select(['i1']);
    const target = service.selectionTarget();
    // law_gestureNoQuietWait (ui-manifest §4.2): a double-click or Enter within the quiet time runs the command; its run asks at once.
    expect(service.enabled('catenary.openIn', target)).toBe(true);
    vi.advanceTimersByTime(SELECTION_QUIET_MS);
    replies.shift()!({ actions: [{ id: 'catenary.openIn', enabled: false, reason: 'no' }], items: [], cards: [] } as SelectionActions);
    await settle();
    expect(service.enabled('catenary.openIn', target)).toBe(false);
    expect(service.enabled('catenary.rename', target)).toBe(false);
});

it('law_disabledGestureShowsReason: gesture runs the command without an answer or when enabled, shows the cached reason, and does not reject', async () => {
    const { service, replies } = fixture();
    const executeCommand = vi.fn(async () => undefined);
    const info = vi.fn(), error = vi.fn();
    Object.assign(service, { commands: { executeCommand }, messages: { info, error } });
    const id = 'catenary.openIn', arg = { ids: ['p'] };
    // No answer yet: the command runs (its run asks at once).
    await service.gesture(id, arg);
    expect(executeCommand).toHaveBeenLastCalledWith(id, arg);
    // The answer arrives (in the app, the run of the command asks for it).
    void service.fetch(service.targetOf(arg));
    replies.shift()!({ actions: [{ id, enabled: false, reason: 'No file and no view has the element.' }], items: [], cards: [] } as SelectionActions);
    await settle();
    // Cached disabled: the reason, and no command (Theia would reject a disabled command).
    executeCommand.mockClear();
    await service.gesture(id, arg);
    expect(info).toHaveBeenLastCalledWith('No file and no view has the element.');
    expect(executeCommand).not.toHaveBeenCalled();
    // A failed run shows the error and does not reject.
    executeCommand.mockRejectedValueOnce(new Error('broken'));
    await expect(service.gesture('catenary.rename', { ids: ['q'] })).resolves.toBeUndefined();
    expect(error).toHaveBeenLastCalledWith('broken');
});
