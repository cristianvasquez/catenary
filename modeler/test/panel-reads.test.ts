import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '@theia/core';
import { AppearanceData, ElementProperties, ModelSnapshot, Selected, SelectionLinks, SnapshotChange, emptySelected } from '@catenary/model';
import { PropertyViewWidget } from '@theia/property-view/lib/browser/property-view-widget';
import { ModelPropertiesWidget } from '../src/browser/properties/properties-widget';
import { AppearanceWidget } from '../src/browser/properties/appearance-widget';
import { LinksWidget } from '../src/browser/properties/links-widget';

// UI manifest §8.11 law_hiddenPanelNoRead: a hidden panel starts no content reads; when shown, it reads the current state once.
// Manifest §10.1 law_saveKeepsRevision: a save keeps the revision, so a shown panel reads nothing for it.
// The browser modules are replaced by a widget that renders synchronously on update() (Lumino posts the update request) and that
// the test hides and shows. The panel code under test is the real code.

const fakes = vi.hoisted(() => {
    const disposable = { dispose() {} };
    class Widget {
        id = '';
        title: Record<string, unknown> = {};
        isVisible = true;
        rendered: unknown;
        readonly toDispose = { push: (_d: unknown) => undefined };
        addClass(_name: string): void {}
        update(): void { this.onUpdateRequest({}); }
        protected onUpdateRequest(_msg: unknown): void { this.rendered = (this as unknown as { render(): unknown }).render(); }
        protected onAfterShow(_msg: unknown): void {}
        protected init(): void {}
        /** Lumino: the shell hides the widget (a collapsed side panel, another tab). */
        hide(): void { this.isVisible = false; }
        /** Lumino: the shell shows the widget, then sends after-show. */
        show(): void { this.isVisible = true; this.onAfterShow({}); }
    }
    class TreeWidget extends Widget {
        constructor(_props: unknown, readonly model: { root?: unknown; selectedNodes: unknown[]; onSelectionChanged: () => typeof disposable }) { super(); }
    }
    /** The Properties owner: Theia attaches the content widget without a widget parent, so the owner tells the visibility. */
    class PropertyViewWidget {
        static readonly ID = 'property-view';
        isVisible = true;
        readonly listeners: ((visible: boolean) => void)[] = [];
        onDidChangeVisibility(l: (visible: boolean) => void) { this.listeners.push(l); return disposable; }
        setVisible(visible: boolean): void { this.isVisible = visible; for (const l of this.listeners) l(visible); }
    }
    return { disposable, Widget, TreeWidget, PropertyViewWidget };
});

vi.mock('@theia/core/lib/browser', () => ({
    ReactWidget: fakes.Widget, TreeWidget: fakes.TreeWidget, AbstractViewContribution: class {}, ApplicationShell: class {}, OpenerService: Symbol('OpenerService'),
    ContextMenuRenderer: class {}, KeybindingContext: Symbol('KeybindingContext'), TreeModel: Symbol('TreeModel'), TreeProps: Symbol('TreeProps'),
    SelectableTreeNode: { is: () => true }, ExpandableTreeNode: { is: (n: { expanded?: boolean }) => n?.expanded !== undefined },
    CompositeTreeNode: { is: (n: { children?: unknown[] }) => Array.isArray(n?.children) }, codicon: (n: string) => n, open: () => undefined
}));
vi.mock('@theia/core/lib/browser/shell/tab-bar-toolbar', () => ({}));
vi.mock('@theia/property-view/lib/browser/property-view-widget', () => ({ PropertyViewWidget: fakes.PropertyViewWidget }));
vi.mock('@theia/property-view/lib/browser/property-view-widget-provider', () => ({ DefaultPropertyViewWidgetProvider: class {} }));
vi.mock('@theia/editor/lib/browser/editor', () => ({}));
vi.mock('@eclipse-glsp/theia-integration', () => ({ GlspSelection: { is: () => false } }));
vi.mock('../src/browser/action-service', () => ({ ActionService: class {}, whenActionsKnown: async () => {} }));
vi.mock('../src/browser/actions', () => ({ ModelActions: class {} }));
vi.mock('../src/browser/diagram/view-editors', () => ({ ViewEditors: class {}, ViewLabels: class {}, viewIdOf: () => undefined }));
vi.mock('../src/browser/diagram/font-preferences', () => ({
    FontPreferences: class {}, CARD_FONT_SIZE: 'card', GROUP_FONT_SIZE: 'group', NOTE_FONT_SIZE: 'note', FONT_MIN: 8, FONT_MAX: 32,
    FONT_DEFAULTS: { card: 14, group: 14, note: 14 }
}));
vi.mock('../src/browser/diagram/edge-preferences', () => ({ EdgePreferences: class {}, EDGE_STYLE_DEFAULT: 'curved' }));
vi.mock('../src/browser/diagram/views', () => ({ COLOR_NAMES: {}, COLOR_ORDER: [], PRESETS: {} }));
vi.mock('../src/browser/diagram/layout-preferences', () => ({ LayoutPreferences: class {} }));
vi.mock('../src/browser/explorer/model-explorer', () => ({ CatenaryNode: { is: () => false } }));
vi.mock('../src/browser/model-client', () => ({ ModelFrontend: class {} }));
vi.mock('../src/browser/menus', () => ({ addMenuItems: () => {} }));
vi.mock('../src/browser/notes/view-notes', () => ({ ViewNotesEditors: class {}, ViewNotesField: () => null }));
vi.mock('../src/browser/notes/view-notes-resource', () => ({ VIEW_NOTES_SCHEME: 'view-notes' }));
vi.mock('../src/browser/properties/shacl-form-host', () => ({ ShaclFormHost: () => null }));
vi.mock('../src/browser/selection-model', () => ({ SelectionModel: class {} }));

const VIEW = 'v1', ID = 'i1';
const editChange: SnapshotChange = { reason: 'edit', tier: 'data', views: [], elements: [ID] };

/** The model of the window: a snapshot that the test changes, and the panel reads of the backend, with the label of the element. */
function fixture() {
    let label = 'Panel before';
    const changes = new Emitter<ModelSnapshot>();
    const model = {
        snapshot: { revision: 1, file: '/w/workspace.trig', files: { files: [], views: [] }, meta: { classes: [] }, warnings: [], shapesVersion: 0 } as unknown as ModelSnapshot,
        get meta() { return this.snapshot.meta; },
        isOpen: true,
        shapesText: '',
        onDidChange: changes.event,
        service: {
            properties: vi.fn(async (id?: string): Promise<ElementProperties> => ({
                kind: 'instance', id: id!, uri: 'urn:x:' + id, label, types: [], fields: {}, targets: {}, shapes: [], results: [], candidates: ''
            } as unknown as ElementProperties)),
            appearance: vi.fn(async (view: string, ids: string[]): Promise<AppearanceData> => ({
                view: { id: view, label: 'View', uri: 'urn:x:' + view, boxes: [], edges: [], arrows: [] },
                labels: Object.fromEntries(ids.map(i => [i, label])), relations: {}, hidden: []
            })),
            links: vi.fn(async (ids: string[]): Promise<SelectionLinks> => ({
                elements: ids.map(id => ({ id, kind: 'instance', label, kindName: 'Thing' })), views: [], rows: [], instances: [], related: []
            } as unknown as SelectionLinks))
        }
    };
    /** A change of the model: `rename` gives the element a new label and a new revision; a save keeps the revision. */
    const change = (c: SnapshotChange, rename?: string) => {
        if (rename) label = rename;
        model.snapshot = { ...model.snapshot, revision: model.snapshot.revision + (c.reason === 'save' ? 0 : 1), change: c };
        changes.fire(model.snapshot);
    };
    const resolved: Selected = { ...emptySelected(), view: VIEW, ids: [ID], elements: [ID], instances: [ID] };
    const elements = { selection: { view: VIEW, ids: [ID] }, resolved, onDidChange: new Emitter<void>().event, onDidResolve: new Emitter<void>().event };
    const editors = { onDidChangeCurrentView: new Emitter<void>().event, current: () => undefined, currentViewId: () => undefined, showLevel: new Map() };
    return { model, elements, editors, change, reads: model.service };
}

/** The text of a rendered React element tree: strings and the string props (a Head shows its title as a prop). */
function textOf(node: unknown): string {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join(' ');
    const props = (node as { props?: Record<string, unknown> }).props ?? {};
    return Object.values(props).map(v => typeof v === 'string' ? v : textOf(v)).join(' ');
}

/**
 * Each panel calls the service synchronously in its update (render or rebuild), before any await: a read count checked right after a
 * change or a show is complete. The answer comes later: wait until the panel shows it.
 */
const shows = (p: { text(): string }, label: string) => vi.waitFor(() => expect(p.text()).toContain(label));

function properties() {
    const f = fixture();
    vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} });
    const owner = new fakes.PropertyViewWidget();
    const shell = { getWidgetById: (id: string) => id === PropertyViewWidget.ID ? owner : undefined, onDidAddWidget: () => fakes.disposable };
    const actionService = { onDidChange: () => fakes.disposable, latest: () => ({ actions: [] }), selectionTarget: () => ({}) };
    const widget = Object.assign(new ModelPropertiesWidget(), { model: f.model, elements: f.elements, editors: f.editors, shell, actionService });
    (widget as unknown as { init(): void }).init();
    return {
        ...f, read: f.reads.properties, text: () => textOf((widget as unknown as { rendered: unknown }).rendered),
        // The shell collapses the side panel or shows another tab: the Properties owner hides; the content widget has no widget parent.
        hide: () => owner.setVisible(false), show: () => owner.setVisible(true)
    };
}

function appearance() {
    const f = fixture();
    const fonts = { onDidChange: () => fakes.disposable, get: () => 14 };
    const edgeStyle = { onDidChange: () => fakes.disposable, get: () => 'curved', vocabulary: () => 'name' };
    const spacingPreference = { onDidChange: () => fakes.disposable, spacing: 50 };
    const widget = Object.assign(new AppearanceWidget(), { model: f.model, elements: f.elements, editors: f.editors, fonts, edgeStyle, spacingPreference, labels: { labels: {} } });
    (widget as unknown as { init(): void }).init();
    return { ...f, read: f.reads.appearance, text: () => textOf((widget as unknown as { rendered: unknown }).rendered), hide: () => widget.hide(), show: () => widget.show() };
}

function links() {
    const f = fixture();
    const tree = { root: undefined as { children: { name: string }[] } | undefined, selectedNodes: [], onSelectionChanged: () => fakes.disposable };
    const widget = new LinksWidget({} as never, tree as never, {} as never);
    Object.assign(widget, { modelFrontend: f.model, elements: f.elements, editors: f.editors, shell: {} });
    (widget as unknown as { init(): void }).init();
    return { ...f, read: f.reads.links, text: () => tree.root?.children.map(n => n.name).join(' ') ?? '', hide: () => widget.hide(), show: () => widget.show() };
}

describe.each([['Properties', properties], ['Appearance', appearance], ['Links', links]])('%s panel', (_name, open) => {
    it('law_hiddenPanelNoRead: a change while the panel is hidden makes no read; the show makes one read and shows the change', async () => {
        const p = open();
        await shows(p, 'Panel before');
        expect(p.read).toHaveBeenCalledTimes(1);
        p.hide();
        p.change(editChange, 'Panel after');
        expect(p.read).toHaveBeenCalledTimes(1);
        expect(p.text()).toContain('Panel before');
        p.show();
        expect(p.read).toHaveBeenCalledTimes(2);
        await shows(p, 'Panel after');
        expect(p.text()).not.toContain('Panel before');
        expect(p.read).toHaveBeenCalledTimes(2);
    });

    it('law_saveKeepsRevision: a save makes no read of a shown panel', async () => {
        const p = open();
        await shows(p, 'Panel before');
        expect(p.read).toHaveBeenCalledTimes(1);
        p.change({ reason: 'save' });
        expect(p.read).toHaveBeenCalledTimes(1);
        expect(p.text()).toContain('Panel before');
    });
});
