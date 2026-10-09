// View editors: GLSP diagram widgets for catenary-view:/<view id> URIs. A view is not a file.

import { CenterAction, EditMode, FitToScreenAction, GViewportRootElement, codiconCSSString } from '@eclipse-glsp/client';
import { GLSPDiagramManager, GLSPDiagramWidget, GLSPDiagramWidgetOptions, GLSPWidgetOpenerOptions } from '@eclipse-glsp/theia-integration';
import { CommandRegistry, Emitter, MessageService, URI } from '@theia/core';
import { ApplicationShell, FrontendApplicationContribution, StatusBar, StatusBarAlignment, WidgetOpenMode, WidgetOpenerOptions } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CONTRIBUTION_ID, DIAGRAM_TYPE, VIEW_SCHEME, viewIdOfUri } from '../../common/protocol';
import { Occurrence, labelProblem, panelsUnchanged } from '@catenary/model';
import { ModelFrontend } from '../model-client';
import { SelectionModel } from '../selection-model';
import { DiagramIds, diagramIds } from './diagram-ids';
import { FontPreferences } from './font-preferences';
import { setCardScaleAction } from './card-scale';

const NEW_VIEW = 'catenary.newView';
const NEXT_OCCURRENCE = 'catenary.nextOccurrence';
const OCCURRENCE_ENTRY = 'catenary-occurrence';

export function viewUri(viewId: string): URI {
    return new URI(`${VIEW_SCHEME}:/${viewId}`);
}

/** Labels of the views (view id → label), from the backend after each model change (RPC `viewLabels`). */
@injectable()
export class ViewLabels {
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    labels: Record<string, string> = {};
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange = this.onDidChangeEmitter.event;
    protected started = false;
    protected sequence = 0;

    start(): void {
        if (this.started) return;
        this.started = true;
        this.model.onDidChange(s => panelsUnchanged(s.change) || void this.refresh());
        void this.refresh();
    }

    protected async refresh(): Promise<void> {
        const n = ++this.sequence;
        const labels = this.model.isOpen ? await this.model.service.viewLabels().catch(() => undefined) : {};
        if (n !== this.sequence || !labels) return;
        this.labels = labels;
        this.onDidChangeEmitter.fire();
    }
}

@injectable()
export class ViewDiagramManager extends GLSPDiagramManager {
    @inject(ViewLabels) protected readonly views: ViewLabels;

    protected override registerOpenWithHandler = false;

    get fileExtensions(): string[] { return []; }
    get diagramType(): string { return DIAGRAM_TYPE; }
    get contributionId(): string { return CONTRIBUTION_ID; }
    get label(): string { return 'View Editor'; }
    override get iconClass(): string { return codiconCSSString('type-hierarchy'); }

    override canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
        return uri.scheme === VIEW_SCHEME ? 1001 : 0;
    }

    protected override createWidgetOptions(uri: URI, options?: GLSPWidgetOpenerOptions): GLSPDiagramWidgetOptions {
        const viewId = viewIdOfUri(uri.toString()) ?? '';
        return {
            diagramType: this.diagramType,
            kind: 'navigatable',
            uri: uri.toString(true),
            iconClass: this.iconClass,
            label: this.views.labels[viewId] ?? viewId,
            editMode: options?.editMode ?? EditMode.EDITABLE
        };
    }
}

/** Finds and controls the open view editors. Keeps titles in sync and closes editors of deleted views. */
@injectable()
export class ViewEditors implements FrontendApplicationContribution {
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(ViewDiagramManager) protected readonly manager: ViewDiagramManager;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(CommandRegistry) protected readonly commands: CommandRegistry;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(StatusBar) protected readonly statusBar: StatusBar;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    @inject(ViewLabels) protected readonly views: ViewLabels;
    @inject(FontPreferences) protected readonly fonts: FontPreferences;

    /** Model point of the last right click on each view editor. */
    readonly menuAt = new WeakMap<GLSPDiagramWidget, { x: number; y: number }>();
    /** Client point of the pointer while it is on the canvas of a view editor (no entry when it is outside). */
    readonly pointerAt = new WeakMap<GLSPDiagramWidget, { x: number; y: number }>();

    protected readonly onDidChangeCurrentViewEmitter = new Emitter<string | undefined>();
    /** Fires when another view editor becomes the current one, or none is. */
    readonly onDidChangeCurrentView = this.onDidChangeCurrentViewEmitter.event;
    protected lastViewId?: string;

    onStart(): void {
        this.views.start();
        this.views.onDidChange(() => this.sync());
        this.model.onDidChange(s => panelsUnchanged(s.change) || this.updateOccurrenceEntry());
        const changed = () => {
            const view = this.currentViewId();
            if (view === this.lastViewId) return;
            this.lastViewId = view;
            this.onDidChangeCurrentViewEmitter.fire(view);
        };
        this.shell.onDidChangeCurrentWidget(changed);
        this.shell.onDidChangeActiveWidget(changed);
        this.onDidChangeCurrentView(() => this.updateOccurrenceEntry());
        this.selection.onDidChange(() => this.updateOccurrenceEntry());
        this.fonts.onDidChange(() => { for (const w of this.all()) void w.actionDispatcher.dispatch(setCardScaleAction(this.fonts.cardScale) as never); });
    }

    onDidInitializeLayout(): void {
        this.decorateTabBars();
        this.shell.mainPanel.layoutModified.connect(() => this.decorateTabBars());
    }

    /**
     * Each main area tab bar (a split makes a new one) gets a "+" button after its tabs, which runs New View,
     * and rename in place on a double click on the tab of a view editor.
     */
    protected decorateTabBars(): void {
        for (const bar of this.shell.mainPanel.tabBars()) {
            const container = bar.node.querySelector('.lm-TabBar-content-container');
            if (!container || container.nextElementSibling?.classList.contains('catenary-new-view')) continue;
            const button = document.createElement('div');
            button.className = 'catenary-new-view codicon codicon-add';
            button.title = 'New view';
            button.onclick = () => {
                if (this.commands.isEnabled(NEW_VIEW)) this.commands.executeCommand(NEW_VIEW);
            };
            container.after(button);
            // Capture phase: before Theia maximizes the area (workbench.tab.maximize).
            bar.node.addEventListener('dblclick', e => {
                const tab = (e.target as Element).closest('.lm-TabBar-tab');
                const index = tab ? [...bar.contentNode.children].indexOf(tab) : -1;
                const w = bar.titles[index]?.owner;
                if (!(w instanceof GLSPDiagramWidget) || w.uri.scheme !== VIEW_SCHEME) return;
                e.stopPropagation();
                this.renameInTab(tab!, viewIdOf(w));
            }, true);
        }
    }

    /**
     * Text input over the tab label. Enter or blur renames the view; Escape cancels. The input is not in the tab:
     * Theia renders the tabs again on each title change.
     */
    protected renameInTab(tab: Element, viewId: string): void {
        const view = this.views.labels[viewId] === undefined ? undefined : { label: this.views.labels[viewId] };
        const label = tab.querySelector('.lm-TabBar-tabLabel') ?? tab;
        if (!view) return;
        const r = label.getBoundingClientRect();
        const input = document.createElement('input');
        input.className = 'catenary-tab-rename theia-input';
        input.value = view.label;
        Object.assign(input.style, { left: `${r.left - 4}px`, top: `${r.top - 3}px`, width: `${Math.max(r.width + 40, 160)}px`, height: `${r.height + 6}px` });
        let done = false;
        const finish = async (commit: boolean) => {
            if (done) return;
            done = true;
            input.remove();
            const value = input.value.trim();
            if (!commit || value === view.label) return;
            const problem = labelProblem(value);
            if (problem) { this.messages.warn(problem); return; }
            await this.model.execute({ kind: 'rename', id: viewId, label: value });
        };
        input.onkeydown = e => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        };
        input.onblur = () => finish(true);
        document.body.appendChild(input);
        input.select();
        input.focus();
    }

    protected sync(): void {
        for (const w of this.all()) {
            const id = viewIdOf(w);
            const label = this.views.labels[id];
            const view = label === undefined ? undefined : { label };
            if (!view) {
                // The view is gone: deleted, or its IRI changed (then open the editor of the new id).
                // No save prompt: the model stays open.
                const moved = this.model.snapshot.movedIds[id];
                if (moved && !this.find(moved)) this.open(moved, w === this.current() ? 'activate' : 'reveal');
                this.shell.closeWidget(w.id, { save: false });
            }
            else if (w.title.label !== view.label) {
                w.title.label = view.label;
                w.title.caption = `View "${view.label}"`;
            }
        }
    }

    all(): GLSPDiagramWidget[] {
        return this.shell.getWidgets('main').filter((w): w is GLSPDiagramWidget => w instanceof GLSPDiagramWidget && w.uri.scheme === VIEW_SCHEME);
    }

    /** The active view editor, else the one visible in the main area. */
    current(): GLSPDiagramWidget | undefined {
        const w = this.shell.activeWidget ?? this.shell.currentWidget;
        if (w instanceof GLSPDiagramWidget && w.uri.scheme === VIEW_SCHEME) return w;
        return this.all().find(x => x.isVisible);
    }

    currentViewId(): string | undefined {
        const w = this.current();
        return w ? viewIdOf(w) : undefined;
    }

    find(viewId: string): GLSPDiagramWidget | undefined {
        return this.all().find(w => viewIdOf(w) === viewId);
    }

    async open(viewId: string, mode: WidgetOpenMode = 'activate', options?: WidgetOpenerOptions): Promise<GLSPDiagramWidget> {
        const isNew = !this.find(viewId);
        const w = await this.manager.open(viewUri(viewId), { ...options, mode });
        // A view opened for the first time in this session fits to the screen.
        if (isNew && !this.fitted.has(viewId)) {
            this.fitted.add(viewId);
            w.actionDispatcher.dispatchOnceModelInitialized(FitToScreenAction.create([], { padding: 40, maxZoom: 1, animate: false }));
        }
        return w;
    }
    protected readonly fitted = new Set<string>();

    /** Open (or show) a view, select elements in it and center them. */
    async reveal(viewId: string, elements: string[]): Promise<void> {
        const w = await this.open(viewId);
        // A view opened now has no model yet: the diagram ids (the placement of a card or an edge) and a CenterAction need it.
        await w.actionDispatcher.onceModelInitialized();
        const ids = elements.map(id => this.placementOf(w, id));
        this.selection.set({ view: viewId, ids });
        await w.actionDispatcher.dispatch(CenterAction.create(ids, { animate: true, retainZoom: true }));
    }

    /**
     * Show a model element: a view opens; an instance or relation is selected and centered in the current view if it is
     * there, else in the first view that has it. If no view has it, it is selected (the side panels show it). False: no view has it.
     */
    async show(id: string): Promise<boolean> {
        const showing = await this.model.service.showing(id);
        if (showing.isView) {
            await this.open(id);
            return true;
        }
        const view = showing.views.find(v => v.id === this.currentViewId()) ?? showing.views[0];
        if (view) await this.reveal(view.id, [view.box]);
        else this.selection.set({ ids: [id] });
        return !!view;
    }

    /** The selected element (one instance or one relation) and the views that show it, from the backend (RPC `occurrence`). */
    occurrence?: Occurrence;
    protected occurrenceSequence = 0;
    protected readonly onDidChangeOccurrenceEmitter = new Emitter<Occurrence | undefined>();
    /** Fires when the occurrence of the selection is known (after each selection or model change). */
    readonly onDidChangeOccurrence = this.onDidChangeOccurrenceEmitter.event;
    /** Resolves when the last occurrence request is done. */
    occurrenceKnown: Promise<void> = Promise.resolve();

    /**
     * Show the selected element in the view after (step 1) or before (step -1) the current view, among the views that
     * show it (viewsShowing), sorted by label, cyclic.
     */
    async nextOccurrence(step: 1 | -1): Promise<void> {
        const views = this.occurrence?.views ?? [];
        if (!views.length) return;
        const i = views.findIndex(v => v.id === this.currentViewId());
        const view = views[i < 0 ? (step === 1 ? 0 : views.length - 1) : (i + step + views.length) % views.length];
        await this.reveal(view.id, [view.box]);
    }

    /** Status bar: "<label> · view i/n" (i: the current view), or "n views" when the current view does not show it. Click: next view. */
    protected updateOccurrenceEntry(): Promise<void> {
        return this.occurrenceKnown = this.fetchOccurrence();
    }

    protected async fetchOccurrence(): Promise<void> {
        const n = ++this.occurrenceSequence;
        const { view, ids } = this.selection.selection;
        const found = this.model.isOpen && ids.length ? await this.model.service.occurrence(ids, view).catch(() => undefined) : undefined;
        if (n !== this.occurrenceSequence) return;
        this.occurrence = found;
        this.onDidChangeOccurrenceEmitter.fire(found);
        const views = found?.views ?? [];
        if (!found || !views.length) {
            this.statusBar.removeElement(OCCURRENCE_ENTRY);
            return;
        }
        const { label } = found;
        const i = views.findIndex(v => v.id === this.currentViewId());
        this.statusBar.setElement(OCCURRENCE_ENTRY, {
            text: `$(search) ${label} · ${i < 0 ? `${views.length} view${views.length > 1 ? 's' : ''}` : `view ${i + 1}/${views.length}`}`,
            alignment: StatusBarAlignment.LEFT, priority: 90, command: NEXT_OCCURRENCE,
            tooltip: `Views that show "${label}": ${views.map(v => v.label).join(', ')}.\nF3: next view, Shift+F3: previous view.`
        });
    }

    /** Last diagram ids of each view editor, kept after it closes: a selection made there still names its placements. */
    protected readonly diagrams = new Map<string, { root: unknown; ids: DiagramIds }>();

    /** The ids of the diagram graph of a view editor; undefined before its first model. */
    diagram(w: GLSPDiagramWidget): DiagramIds | undefined {
        let root;
        try { root = w.editorContext.modelRoot; } catch { return undefined; }
        const viewId = viewIdOf(w), known = this.diagrams.get(viewId);
        if (known?.root === root) return known.ids;
        const ids = diagramIds(root.index.all() as Iterable<{ id: string; element?: unknown }>);
        this.diagrams.set(viewId, { root, ids });
        return ids;
    }

    /** The element that a diagram id of a view editor shows (a card or a placed edge: its element); other ids stay. */
    elementOf(w: GLSPDiagramWidget, id: string): string {
        return this.diagram(w)?.elementOf(id) ?? id;
    }

    /** The diagram id that shows an element in a view editor (its card or edge); other ids stay. */
    placementOf(w: GLSPDiagramWidget, id: string): string {
        return this.diagram(w)?.placementOf(id) ?? id;
    }

    /** The element of a placement of view `viewId`: from its open editor, else from the last graph that it had. Other ids stay. */
    elementIn(viewId: string, id: string): string {
        const w = this.find(viewId);
        return (w ? this.diagram(w) : this.diagrams.get(viewId)?.ids)?.elementOf(id) ?? id;
    }

    /** Resolves when the diagram of a view editor has all `ids` (the update of an edit comes after its result), or after `timeout` ms. */
    whenShown(widget: GLSPDiagramWidget, ids: string[], timeout = 2000): Promise<void> {
        const shown = () => { const index = widget.editorContext.modelRoot.index; return ids.every(id => index.getById(id)); };
        if (shown()) return Promise.resolve();
        return new Promise(resolve => {
            const done = () => { clearTimeout(timer); listener.dispose(); resolve(); };
            const listener = widget.editorContext.onModelRootChanged(() => { if (shown()) done(); });
            const timer = setTimeout(done, timeout);
        });
    }

    /** Fit the whole diagram of a view editor to the screen (at most 100 %). */
    fit(widget: GLSPDiagramWidget): Promise<void> {
        return widget.actionDispatcher.dispatch(FitToScreenAction.create([], { padding: 40, maxZoom: 1, animate: true }));
    }

    /** Resolves at the next change of the diagram of a view editor (the update of an edit), or after `timeout` ms. */
    whenChanged(widget: GLSPDiagramWidget, timeout = 2000): Promise<void> {
        return new Promise(resolve => {
            const done = () => { clearTimeout(timer); listener.dispose(); resolve(); };
            const listener = widget.editorContext.onModelRootChanged(done);
            const timer = setTimeout(done, timeout);
        });
    }

    /** Client point -> model point of a view editor. */
    toModel(widget: GLSPDiagramWidget, clientX: number, clientY: number): { x: number; y: number } {
        const svg = widget.node.querySelector('svg');
        const root = widget.editorContext.modelRoot as unknown as GViewportRootElement;
        const r = svg?.getBoundingClientRect() ?? widget.node.getBoundingClientRect();
        const zoom = root.zoom ?? 1, scroll = root.scroll ?? { x: 0, y: 0 };
        return { x: (clientX - r.left) / zoom + scroll.x, y: (clientY - r.top) / zoom + scroll.y };
    }

    /** Model point where a new card goes: the pointer when it is on the canvas, else the center of the visible canvas. */
    dropPoint(widget: GLSPDiagramWidget): { x: number; y: number } {
        const p = this.pointerAt.get(widget);
        return p ? this.toModel(widget, p.x, p.y) : this.center(widget);
    }

    /** Model point at the center of the visible canvas. */
    center(widget: GLSPDiagramWidget): { x: number; y: number } {
        const r = widget.node.getBoundingClientRect();
        return this.toModel(widget, r.left + r.width / 2, r.top + r.height / 2);
    }
}

export function viewIdOf(widget: GLSPDiagramWidget): string {
    return viewIdOfUri(widget.uri.toString()) ?? '';
}
