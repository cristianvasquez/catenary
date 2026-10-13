import { expect, it, vi } from 'vitest';
import { hasRowMenu, LinkNode } from '../src/browser/properties/links-widget';

// Browser-only modules supply DI tokens and base classes, not behavior under test.
vi.mock('@theia/core/lib/browser', () => ({
    AbstractViewContribution: class {}, ContextMenuRenderer: class {}, KeybindingContext: Symbol('KeybindingContext'), TreeModel: Symbol('TreeModel'),
    TreeProps: Symbol('TreeProps'), TreeWidget: class {}, ApplicationShell: class {}, SelectableTreeNode: { is: () => true }, codicon: (n: string) => n
}));
vi.mock('@theia/core/lib/browser/shell/tab-bar-toolbar', () => ({}));
vi.mock('../src/browser/action-service', () => ({ ActionService: class {}, whenActionsKnown: async () => {} }));
vi.mock('../src/browser/actions', () => ({ ModelActions: class {} }));
vi.mock('../src/browser/diagram/view-editors', () => ({ ViewEditors: class {} }));
vi.mock('../src/browser/model-client', () => ({ ModelFrontend: class {} }));
vi.mock('../src/browser/menus', () => ({ addMenuItems: () => {} }));
vi.mock('../src/browser/properties/controls', () => ({ Head: () => null }));
vi.mock('../src/browser/selection-model', () => ({ SelectionModel: class {} }));

// LINKS1: a folder row has no target, so a right-click on it opens no (empty) context menu. Rows with a target keep their menu.
it('a folder row of the Links panel has no context menu, the other rows have one', () => {
    expect(hasRowMenu({ link: 'folder' })).toBe(false);
    const rows: LinkNode['link'][] = ['view', 'out', 'in', 'end', 'instance', 'related', 'head'];
    for (const link of rows) expect(hasRowMenu({ link }), link).toBe(true);
});
