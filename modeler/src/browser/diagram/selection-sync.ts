// View editors show the SelectionModel (spec/ui-manifest.hs §3.3 law_oneSelectionPerWindow): one selection per window. The canvas of
// its view (the origin) holds it as its GLSP selection; the canvases of other views highlight the same elements (canvas-highlight.ts).
// A user gesture in a view editor goes the other way, through FocusedSelectionForwarder (diagram-configuration.ts).
// A SelectAction goes to the origin canvas only when its GLSP selection differs from the window selection (a selection set by a
// command, an element that has just arrived), and to the old origin once, to clear it. A highlight changes no GLSP selection.

import { SelectAction } from '@eclipse-glsp/client';
import { GLSPDiagramWidget } from '@eclipse-glsp/theia-integration';
import { ApplicationShell, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { LABEL_SUFFIX, ownerOfLabel, panelsUnchanged } from '@catenary/model';
import { VIEW_SCHEME } from '../../common/protocol';
import { ModelFrontend } from '../model-client';
import { SelectionModel, sameIds } from '../selection-model';
import { CanvasHighlight, HighlightAction } from './canvas-highlight';
import { canvasSelection, toggleHighlight } from './diagram-ids';
import { ViewEditors, viewIdOf } from './view-editors';

@injectable()
export class DiagramSelectionSync implements FrontendApplicationContribution {
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    protected readonly installed = new WeakSet<GLSPDiagramWidget>();

    onStart(): void {
        this.selection.onDidChange(() => this.editors.all().forEach(w => this.apply(w)));
        // The snapshot and the diagram updates come on different connections: apply again when either arrives. A snapshot also
        // redraws the halo of one selected element: its expand counts come from the frontend doc, not from the diagram.
        this.model.onDidChange(s => panelsUnchanged(s.change) || this.editors.all().forEach(w => this.apply(w, true)));
        this.shell.onDidAddWidget(w => {
            if (w instanceof GLSPDiagramWidget && w.uri.scheme === VIEW_SCHEME) this.install(w);
        });
        this.editors.all().forEach(w => this.install(w));
        // Capture phase on the window: before the GLSP mouse tools and the canvas listeners (canvas.ts) of the pressed canvas.
        window.addEventListener('mousedown', e => this.press(e), true);
        window.addEventListener('click', e => this.click(e), true);
    }

    onDidInitializeLayout(): void {
        this.editors.all().forEach(w => this.install(w));
    }

    /** Apply the selection again after each model update: a view opened now, or an element that has just arrived. */
    protected install(w: GLSPDiagramWidget): void {
        if (this.installed.has(w)) return;
        this.installed.add(w);
        const listener = w.editorContext.onModelRootChanged(() => this.apply(w));
        w.disposed.connect(() => listener.dispose());
        this.apply(w);
    }

    protected apply(w: GLSPDiagramWidget, redraw = false): void {
        // A new view editor has no model yet (the getter throws); onModelRootChanged applies the selection when it arrives.
        const ids = this.editors.diagram(w);
        const highlight = this.highlightOf(w);
        if (!ids || !highlight) return;
        const { selected, highlighted } = canvasSelection(ids, this.selection.selection, viewIdOf(w), (view, id) => this.editors.elementIn(view, id),
            w.editorContext.modelRoot.id);
        const have = [...new Set(w.editorContext.selectedElements.map(e => ownerOfLabel(e.id)))];
        const select = !sameIds(selected, have);
        if (select) w.actionDispatcher.dispatch(SelectAction.create({ selectedElementsIDs: selected, deselectedElementsIDs: true }));
        if (!sameIds(highlighted, [...highlight.ids]) || (redraw && !select && selected.length === 1)) w.actionDispatcher.dispatch(HighlightAction.create(highlighted));
    }

    /** The highlight state of a view editor (its diagram container), undefined before the container exists. */
    protected highlightOf(w: GLSPDiagramWidget): CanvasHighlight | undefined {
        try { return w.diContainer.get(CanvasHighlight); } catch { return undefined; }
    }

    /** The view editor whose diagram (svg) contains an event target. */
    protected canvasAt(e: MouseEvent): GLSPDiagramWidget | undefined {
        const target = e.target as Element | null;
        if (!target?.closest?.('svg.sprotty-graph')) return undefined;
        return this.editors.all().find(w => w.node.contains(target));
    }

    /**
     * A Ctrl, Meta or Shift press adds to the selection, also from another canvas (law_oneSelectionPerWindow). On an element of a
     * canvas with a highlight, the press acts on the highlight: the canvas becomes the origin with the highlight plus the element,
     * or minus it when it is highlighted. GLSP and the canvas listeners do not get this press: they read the `selected` flags,
     * and a SelectAction sets them only later (the dispatcher is asynchronous). On empty canvas (a marquee), the canvas takes the
     * highlight as its GLSP selection first, and the marquee adds to it.
     */
    protected press(e: MouseEvent): void {
        if (e.button !== 0 || !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
        const w = this.canvasAt(e), highlight = w && this.highlightOf(w);
        if (!w || !highlight?.ids.size) return;
        const id = this.pressedId(w, e.target as Element);
        const ids = [...highlight.ids];
        if (id !== undefined) {
            e.stopPropagation();
            this.selection.set({ view: viewIdOf(w), ids: toggleHighlight(ids, id) });
            return;
        }
        w.actionDispatcher.dispatch(HighlightAction.create([]));
        w.actionDispatcher.dispatch(SelectAction.create({ selectedElementsIDs: ids, deselectedElementsIDs: true }));
    }

    /** The diagram id of the element under a press (a card, an edge, a row; the owner of a label), undefined on empty canvas. */
    protected pressedId(w: GLSPDiagramWidget, target: Element | null): string | undefined {
        const ids = this.editors.diagram(w), prefix = w.viewerOptions.baseDiv + '_';
        if (!ids) return undefined;
        const root = w.editorContext.modelRoot.id;
        for (let el = target; el && el !== w.node; el = el.parentElement) {
            if (!el.id?.startsWith(prefix)) continue;
            // A label (a group title, a card name) selects its owner, also when the index holds the label itself. A leaf keeps its id.
            const raw = el.id.slice(prefix.length), id = raw.endsWith(LABEL_SUFFIX) ? raw.slice(0, -LABEL_SUFFIX.length) : raw;
            if (id !== root && ids.has(id)) return id;
        }
        return undefined;
    }

    /**
     * A plain click on empty canvas clears the selection. In a canvas that is not the origin, GLSP sees no change (its selection
     * is empty), and the forwarder gets no event: the canvas becomes the origin of an empty selection here.
     */
    protected click(e: MouseEvent): void {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const w = this.canvasAt(e);
        if (!w || !this.selection.selection.ids.length) return;
        const view = viewIdOf(w);
        if (!view || this.selection.selection.view === view || w.editorContext.selectedElements.length) return;
        this.selection.set({ view, ids: [] });
    }
}
