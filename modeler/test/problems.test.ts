import { expect, it, vi } from 'vitest';
import { URI } from '@theia/core';
import { ElementOpenHandler, elementUri, problemInstance } from '../src/browser/problems';
import { SelectionModel } from '../src/browser/selection-model';
import { ModelSelection, emptySelected } from '@catenary/model';

// Browser-only modules supply DI tokens and base classes, not behavior under test.
vi.mock('@theia/core/lib/browser', () => ({
    ContextMenuRenderer: class {}, StatusBar: class {}, StatusBarAlignment: {}, TreeProps: Symbol('TreeProps'), codicon: (n: string) => n
}));
vi.mock('@theia/markers/lib/browser/problem/problem-widget', () => ({ ProblemWidget: class {} }));
vi.mock('@theia/markers/lib/browser/problem/problem-tree-model', () => ({ ProblemTreeModel: class {} }));
vi.mock('../src/browser/action-service', () => ({ ActionService: class {}, whenActionsKnown: async () => {} }));
vi.mock('../src/browser/diagram/canvas', () => ({ DND_INSTANCES: 'application/x-catenary-instances' }));
vi.mock('@theia/markers/lib/browser/problem/problem-manager', () => ({ ProblemManager: class {} }));
vi.mock('../src/browser/model-client', () => ({ ModelFrontend: class {} }));
vi.mock('@theia/property-view/lib/browser/property-view-contribution', () => ({ PropertyViewContribution: class {} }));
vi.mock('../src/browser/commands', () => ({ OpenModelCommands: { OPEN: { id: 'open' } } }));

function fixture() {
    const commands = { executeCommand: vi.fn(async () => undefined) };
    const selection = Object.assign(new SelectionModel(), { model: {
        onDidChange: () => ({ dispose() {} }), snapshot: { revision: 0 }, isOpen: true,
        service: { selected: async (s: ModelSelection) => ({ ...emptySelected(), view: s.view, ids: s.ids, elements: s.ids }) }
    } });
    const properties = { openView: vi.fn(async () => ({})) };
    const handler = Object.assign(new ElementOpenHandler(), { commands, selection, properties });
    return { handler, commands, selection, properties };
}

it('a click on a problem selects its instance, reveals Properties and opens no view', async () => {
    const { handler, commands, selection, properties } = fixture();
    await handler.open(elementUri('i1'), { mode: 'reveal' } as object);
    expect(selection.selection).toEqual({ view: undefined, ids: ['i1'] });
    expect(properties.openView).toHaveBeenCalledWith({ activate: false, reveal: true });
    expect(commands.executeCommand).not.toHaveBeenCalled();
});

it('a double-click on a problem runs Open in… on its instance', async () => {
    const { handler, commands } = fixture();
    await handler.open(elementUri('i1'));
    expect(commands.executeCommand).toHaveBeenCalledWith('catenary.openIn', { ids: ['i1'] });
});

it('a click on a problem without a focus instance changes no selection', async () => {
    const { handler, selection } = fixture();
    await handler.open(new URI('catenary:/model'), { mode: 'reveal' } as object);
    expect(selection.selection.ids).toEqual([]);
});

it('a Problems row has an instance for the menu and the drag, the model row has none', () => {
    expect(problemInstance({ uri: elementUri('i1') } as never)).toBe('i1');
    expect(problemInstance({ uri: new URI('catenary:/model') } as never)).toBeUndefined();
    expect(problemInstance({ uri: new URI('file:///a.ttl') } as never)).toBeUndefined();
});
