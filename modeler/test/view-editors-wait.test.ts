import { afterEach, expect, it, vi } from 'vitest';

// The GLSP and Theia modules need a browser; the wait uses none of them.
vi.mock('@eclipse-glsp/client', () => ({ CenterAction: {}, EditMode: {}, FitToScreenAction: {}, GViewportRootElement: class {}, codiconCSSString: () => '' }));
vi.mock('@eclipse-glsp/theia-integration', () => ({ GLSPDiagramManager: class {}, GLSPDiagramWidget: class {} }));
vi.mock('@theia/core/lib/browser', () => ({ ApplicationShell: class {}, StatusBar: class {}, StatusBarAlignment: {}, WidgetOpenMode: {} }));
vi.mock('../src/browser/diagram/view-widget', () => ({ ViewDiagramWidget: class {} }));
vi.mock('../src/browser/diagram/font-preferences', () => ({ FontPreferences: class {} }));
vi.mock('../src/browser/diagram/card-scale', () => ({ setCardScaleAction: () => ({}) }));

import { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { ViewEditors } from '../src/browser/diagram/view-editors';

afterEach(() => { vi.useRealTimers(); });

/** A view editor whose GLSP index holds the card `n-card` of the element `urn:a` (a placement id, not the raw id). */
function editor() {
    const nodes = [{ id: 'n-card', element: 'urn:a' }];
    const index = { getById: (id: string) => nodes.find(n => n.id === id), all: () => nodes };
    const widget = {
        uri: { toString: () => 'catenary-view:/v' },
        editorContext: { modelRoot: { index }, onModelRootChanged: () => ({ dispose() {} }) }
    } as unknown as GLSPDiagramWidget;
    const editors = Object.assign(Object.create(ViewEditors.prototype) as ViewEditors, { diagrams: new Map() });
    return { editors, widget, index };
}

it('the selection after an edit waits on placements: whenPlaced resolves at once for an element whose card the index holds (kata rkyk)', async () => {
    vi.useFakeTimers();
    const { editors, widget, index } = editor();
    // The raw id is not in the index: a wait on it would end only at its 2 s timeout.
    expect(index.getById('urn:a')).toBeUndefined();
    let resolved = false;
    void editors.whenPlaced(widget, ['urn:a']).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

it('whenPlaced waits for an element without a card until the timeout', async () => {
    vi.useFakeTimers();
    const { editors, widget } = editor();
    let resolved = false;
    void editors.whenPlaced(widget, ['urn:b']).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(resolved).toBe(true);
});
