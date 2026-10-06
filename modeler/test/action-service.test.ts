import { expect, it, vi } from 'vitest';
import type { SelectionActions } from '@catenary/model';

vi.mock('../src/browser/model-client', () => ({ ModelFrontend: class {} }));
vi.mock('../src/browser/diagram/view-editors', () => ({ ViewEditors: class {} }));
vi.mock('../src/browser/selection-model', () => ({ SelectionModel: class {} }));

import { ActionService } from '../src/browser/action-service';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const answer = (label: string): SelectionActions => ({ actions: [{ id: label, enabled: true }], items: [], cards: [] }) as SelectionActions;

function fixture() {
    let changed: (s: { change?: object }) => void = () => undefined;
    const replies: ((a: SelectionActions) => void)[] = [];
    const model = {
        isOpen: true,
        onDidChange: (l: typeof changed) => { changed = l; return { dispose() {} }; },
        service: { selectionActions: () => new Promise<SelectionActions>(resolve => replies.push(resolve)) }
    };
    const selection = { selection: { view: undefined, ids: ['i1'] }, onDidChange: () => ({ dispose() {} }) };
    const editors = { currentViewId: () => undefined, onDidChangeCurrentView: () => ({ dispose() {} }) };
    const service = Object.assign(new ActionService(), { model, selection, editors });
    (service as unknown as { init(): void }).init();
    return { service, replies, change: () => changed({ change: { reason: 'edit' } }) };
}

it('latest keeps the answer of the last revision until the new answer arrives; get does not', async () => {
    const { service, replies, change } = fixture();
    const target = service.selectionTarget();
    expect(service.get(target).actions).toEqual([]);
    replies.shift()!(answer('a'));
    await settle();
    expect(service.get(target).actions.map(a => a.id)).toEqual(['a']);

    change();
    expect(service.get(target).actions).toEqual([]);
    expect(service.latest(target).actions.map(a => a.id)).toEqual(['a']);

    replies.shift()!(answer('b'));
    await settle();
    expect(service.get(target).actions.map(a => a.id)).toEqual(['b']);
    expect(service.latest(target).actions.map(a => a.id)).toEqual(['b']);
});
