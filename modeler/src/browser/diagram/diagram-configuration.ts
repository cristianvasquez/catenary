// Client DI container of a view editor.

import {
    ConsoleLogger, ContainerConfiguration, CutOperation, DefaultTypes, FeatureModule, GGraph, GLabel, GModelRoot, GResizeHandle,
    LocalClipboardService, LogLevel, RequestClipboardDataAction, ServerCopyPasteHandler, TYPES, bindOrRebind, configureModelElement, configureView,
    KeyboardToolPalette, generateUuid, gridModule, configureActionHandler, IActionHandler, ViewerOptions,
    Action, CursorCSS, EnableToolsAction, GModelElement, KeyListener, MarqueeMouseListener, MarqueeMouseTool, MarqueeTool, cursorFeedbackAction,
    helperLineModule, initializeDiagramContainer, accessibilityModule, toolPaletteModule, createIcon, FocusTrackerTool, PaletteItem,
    ChangeBoundsOperation, CompoundOperation, configureCommand, createDiagramOptionsModule, IDiagramOptions, FitToScreenAction
} from '@eclipse-glsp/client';
import { GLSPDiagramConfiguration, TheiaGLSPSelectionForwarder } from '@eclipse-glsp/theia-integration';
import { CommandRegistry, CommandService, MessageService } from '@theia/core';
import { Container, inject, injectable } from '@theia/core/shared/inversify';
import { TYPES as CATENARY, boxOf, ownerOfLabel } from '@catenary/model';
import { DIAGRAM_TYPE, viewIdOfUri } from '../../common/protocol';
import { SelectionModel } from '../selection-model';
import { ModelActions } from '../actions';
import { ModelCommands } from '../commands';
import { ViewHistory } from './view-history';
import { ModelFrontend } from '../model-client';
import { NoteEditor } from '../notes/note-editor';
import { editCanvasName } from './name-edit';
import { ViewEditors } from './view-editors';
import { CardScaleStartup } from './card-scale';
import { FontPreferences } from './font-preferences';
import { ApplyPendingBoundsCommand, PendingBounds } from './pending-bounds';
import { ApplyPendingMembersCommand, PendingMemberAction, PendingMembers } from './pending-members';
import {
    AlternativeEdge, AlternativeEdgeView, LatentEdge, LatentEdgeView, TargetingEdge, TargetingEdgeView, ArrowEdge, ArrowEdgeView, BundleEdge, BundleEdgeView, CardNode, CardView, CollectionNode, CollectionView, GroupNode, GroupView, LeafNode, LeafView, LogicNode, LogicView, NameLabelView,
    NoteNode, NoteView, PropertyEdge, PropertyEdgeView, RelationEdge, RelationEdgeView, ResizeHandleView, ShapeCardView, ShapeNode, ShapeRow, ShapeRowView, ValueSetNode, ValueSetView,
    CatenaryGraphView, ViewReferenceNode, ViewReferenceView
} from './views';

@injectable()
export class EditCreatedCanvasName implements IActionHandler {
    @inject(TYPES.ViewerOptions) protected readonly viewer: ViewerOptions;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(NoteEditor) protected readonly notes: NoteEditor;
    @inject(ViewEditors) protected readonly editors: ViewEditors;

    handle(action: Action): void {
        const { id, view } = action as Action & { id: string; view: string };
        // The model update and the action cross different frontend connections. Wait for the card DOM, not for a fixed delay.
        // A note has no name slot: its text opens in the note editor.
        let attempts = 0;
        void this.model.service.view(view).then(stored => {
            const tryEdit = () => {
                if (boxOf(stored, id)?.kind === 'note') return void this.notes.open(view, id);
                const w = this.editors.find(view);
                if (w && editCanvasName(w, id, view, this.editors, this.model, true)) return;
                if (++attempts < 120) requestAnimationFrame(tryEdit);
            };
            requestAnimationFrame(tryEdit);
        });
    }
}

export const viewDiagramModule = new FeatureModule((bind, unbind, isBound, rebind) => {
    const context = { bind, unbind, isBound, rebind };
    bindOrRebind(context, TYPES.ILogger).to(ConsoleLogger).inSingletonScope();
    bindOrRebind(context, TYPES.LogLevel).toConstantValue(LogLevel.warn);
    bind(CardScaleStartup).toSelf().inSingletonScope();
    bind(TYPES.IDiagramStartup).toService(CardScaleStartup);
    configureModelElement(context, DefaultTypes.GRAPH, GGraph, CatenaryGraphView);
    configureModelElement(context, CATENARY.CARD, CardNode, CardView);
    configureModelElement(context, CATENARY.GROUP, GroupNode, GroupView);
    configureModelElement(context, CATENARY.NOTE, NoteNode, NoteView);
    configureModelElement(context, CATENARY.VIEW_REFERENCE, ViewReferenceNode, ViewReferenceView);
    configureModelElement(context, CATENARY.RELATION, RelationEdge, RelationEdgeView);
    configureModelElement(context, CATENARY.COLLECTION, CollectionNode, CollectionView);
    configureModelElement(context, CATENARY.BUNDLE, BundleEdge, BundleEdgeView);
    configureModelElement(context, CATENARY.ARROW, ArrowEdge, ArrowEdgeView);
    configureModelElement(context, CATENARY.NAME, GLabel, NameLabelView);
    configureModelElement(context, CATENARY.SHAPE, ShapeNode, ShapeCardView);
    configureModelElement(context, CATENARY.ROW, ShapeRow, ShapeRowView);
    configureModelElement(context, CATENARY.PROPERTY, PropertyEdge, PropertyEdgeView);
    configureModelElement(context, CATENARY.LEAF, LeafNode, LeafView);
    configureModelElement(context, CATENARY.ALTERNATIVE, AlternativeEdge, AlternativeEdgeView);
    configureModelElement(context, CATENARY.LATENT, LatentEdge, LatentEdgeView);
    configureModelElement(context, CATENARY.TARGETING, TargetingEdge, TargetingEdgeView);
    configureModelElement(context, CATENARY.LOGIC, LogicNode, LogicView);
    configureModelElement(context, CATENARY.VALUESET, ValueSetNode, ValueSetView);
    configureView(context, GResizeHandle.TYPE, ResizeHandleView, true);
    configureActionHandler(context, 'catenaryEditCanvasName', EditCreatedCanvasName);
    // A server update sent before the server applied the last drop does not draw the box at its older place (pending-bounds.ts).
    bind(PendingBounds).toSelf().inSingletonScope();
    configureActionHandler(context, ChangeBoundsOperation.KIND, PendingBounds);
    configureActionHandler(context, CompoundOperation.KIND, PendingBounds);
    configureCommand(context, ApplyPendingBoundsCommand);
    // "+ concept" / "+ member" of a value set card: the new row shows at once (pending-members.ts).
    bind(PendingMembers).toSelf().inSingletonScope();
    configureActionHandler(context, PendingMemberAction.KIND, PendingMembers);
    configureCommand(context, ApplyPendingMembersCommand);
}, { featureId: Symbol('catenaryViewDiagram') });

/**
 * A selection change in the view editor that has the focus is a user gesture: it goes to the SelectionModel, and to the
 * Theia selection (the Property view picks its provider from it). A change in another view editor comes from the
 * SelectionModel (DiagramSelectionSync) and is not sent back. On focus gain, the base class forwards the current diagram selection.
 */
@injectable()
export class FocusedSelectionForwarder extends TheiaGLSPSelectionForwarder {
    @inject(SelectionModel) protected readonly selection: SelectionModel;

    override selectionChanged(root: Readonly<GModelRoot>, selectedElements: string[]): void {
        const base = document.getElementById(this.viewerOptions.baseDiv);
        if (!base?.contains(document.activeElement)) return;
        const view = viewIdOfUri(this.editorContext.sourceUri ?? '');
        if (view) this.selection.set({ view, ids: selectedElements.map(ownerOfLabel).filter(id => id !== root.id) });
        super.selectionChanged(root, selectedElements);
    }
}

const selectionForwarderModule = new FeatureModule((_bind, _unbind, _isBound, rebind) => {
    rebind(TheiaGLSPSelectionForwarder).to(FocusedSelectionForwarder).inSingletonScope();
}, { featureId: Symbol('catenarySelectionForwarder') });

/**
 * Copy, cut and paste while any element of the view editor has the focus. GLSP accepts only an element
 * whose parent is the base div; a click on empty canvas focuses the svg one level deeper, and the paste was ignored.
 * A cut requests the clip with `args.mode = 'cut'`: its paste adds the same instances; the paste of a copy creates new ones.
 */
@injectable()
export class ViewCopyPasteHandler extends ServerCopyPasteHandler {
    @inject(FontPreferences) protected readonly fonts: FontPreferences;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    @inject(MessageService) protected readonly messages: MessageService;

    override handlePaste(event: ClipboardEvent): void {
        if (!event.clipboardData || !this.shouldPaste(event)) return;
        const data = event.clipboardData;
        try {
            if (typeof JSON.parse(data.getData('text/plain')).clipboardId === 'string') {
                super.handlePaste(event);
                return;
            }
        } catch { /* Plain RDF is not a Catenary clip token. */ }
        const mediaType = ['text/turtle', 'application/trig', 'application/n-triples', 'application/n-quads',
            'application/ld+json', 'application/rdf+xml', 'text/n3'].find(type => data.types.includes(type));
        const text = data.getData(mediaType ?? 'text/plain');
        const view = viewIdOfUri(this.editorContext.sourceUri ?? '');
        if (!view) return;
        const at = this.editorContext.get().lastMousePosition;
        event.preventDefault();
        void this.pasteRdf(view, text, mediaType, at);
    }

    protected async pasteRdf(view: string, text: string, mediaType?: string, at?: { x: number; y: number }): Promise<void> {
        try {
            const parsed = await this.model.service.prepareRdfPaste(text, mediaType);
            if (!parsed.ok) { this.messages.warn(parsed.error); return; }
            if (parsed.namedGraphs.length && !await this.actions.confirm('Paste RDF with Named Graphs',
                'This RDF contains named graphs. Continuing will merge their statements into the model and discard the graph names.',
                'Flatten and paste')) return;
            const r = await this.model.execute({ kind: 'pasteRdf', view, rdf: parsed.rdf, flatten: parsed.namedGraphs.length > 0, at, cardScale: this.fonts.cardScale });
            if (!r.ok) return;
            this.selection.set({ view, ids: r.ids ?? [] });
            if (!r.ids?.length) { this.messages.info('RDF added; no new figures in this canvas.'); return; }
            // The RPC response and the GLSP update use different connections. Fit after the arriving model is available.
            const shown = await new Promise<string[]>(resolve => {
                let frames = 0;
                const check = () => {
                    const ids = r.ids!.filter(id => this.editorContext.modelRoot.index.getById(id));
                    if (ids.length || ++frames >= 120) resolve(ids);
                    else requestAnimationFrame(check);
                };
                check();
            });
            if (shown.length) await this.actionDispatcher.dispatch(FitToScreenAction.create(shown, { padding: 40, maxZoom: 1, animate: false }));
        } catch (e) { this.messages.warn(`RDF paste failed: ${e instanceof Error ? e.message : String(e)}`); }
    }

    override handleCut(event: ClipboardEvent): void {
        if (!event.clipboardData || !this.shouldCopy(event)) return;
        const clipboardId = generateUuid();
        event.clipboardData.setData('text/plain', JSON.stringify({ clipboardId }));
        this.actionDispatcher.request(RequestClipboardDataAction.create(this.editorContext.get({ mode: 'cut' })))
            .then(action => this.clipboardService.put(action.clipboardData, clipboardId));
        this.actionDispatcher.dispatch(CutOperation.create(this.editorContext.get()));
        event.preventDefault();
    }

    protected override shouldCopy(_event: ClipboardEvent): boolean {
        return this.editorContext.get().selectedElementIds.length > 0 && this.hasFocus();
    }

    protected override shouldPaste(_event: ClipboardEvent): boolean {
        return this.hasFocus();
    }

    protected hasFocus(): boolean {
        return !!document.getElementById(this.viewerOptions.baseDiv)?.contains(document.activeElement);
    }
}

/**
 * One clipboard for all view editors of the window. GLSP binds one for each diagram container, so a clip
 * copied in one view editor was not found by a paste in another one.
 */
const sharedClipboard = new LocalClipboardService();
const copyPasteModule = new FeatureModule((bind, _unbind, isBound, rebind) => {
    bindOrRebind({ bind, isBound, rebind }, TYPES.IAsyncClipboardService).toConstantValue(sharedClipboard);
    bindOrRebind({ bind, isBound, rebind }, TYPES.ICopyPasteHandler).to(ViewCopyPasteHandler);
}, { featureId: Symbol('catenaryCopyPaste') });

/**
 * Shift+drag on the canvas: marquee that adds to the selection. GLSP enables the marquee only when nothing is selected,
 * and keeps the previous selection only with Ctrl.
 */
class ShiftMarqueeKeyListener extends KeyListener {
    override keyDown(_element: GModelElement, event: KeyboardEvent): Action[] {
        return event.shiftKey ? [EnableToolsAction.create([MarqueeMouseTool.ID])] : [];
    }
}

@injectable()
export class AddingMarqueeTool extends MarqueeTool {
    override enable(): void {
        this.toDisposeOnDisable.push(this.keyTool.registerListener(new ShiftMarqueeKeyListener()));
    }
}

class AddingMarqueeMouseListener extends MarqueeMouseListener {
    override mouseDown(target: GModelElement, event: MouseEvent): Action[] {
        const result = super.mouseDown(target, event);
        this.previouslySelected = [...target.root.index.all()].filter(e => (e as { selected?: boolean }).selected).map(e => e.id);
        return result;
    }
}

@injectable()
export class AddingMarqueeMouseTool extends MarqueeMouseTool {
    /** As the base class, with AddingMarqueeMouseListener. */
    override enable(): void {
        this.toDisposeOnDisable.push(
            this.mouseTool.registerListener(new AddingMarqueeMouseListener(this.editorContext.modelRoot, this.marqueeUtil)),
            this.keyTool.registerListener(this.shiftKeyListener),
            this.createFeedbackEmitter().add(cursorFeedbackAction(CursorCSS.MARQUEE), cursorFeedbackAction()).submit()
        );
    }
}

const marqueeModule = new FeatureModule((_bind, _unbind, _isBound, rebind) => {
    rebind(MarqueeTool).to(AddingMarqueeTool).inSingletonScope();
    rebind(MarqueeMouseTool).to(AddingMarqueeMouseTool).inSingletonScope();
}, { featureId: Symbol('catenaryMarquee') });

/** Classes of the shapes in the bar: at most this number of rows; the others are behind "+N". */
const CLASS_ROWS = 2;

/** The sections of the bar, left to right, and the palette items that each section holds. */
const SECTIONS: [section: string, title: string, items: string[]][] = [
    ['shape', 'Shapes', ['node-shape']],
    ['skos', 'SKOS', ['scheme', 'collection']],
    ['classes', 'New instance of a class', []],
    ['view', 'View marks', ['group', 'note']]
];

/**
 * Tool palette: a bar of two rows above the canvas. Left to right: Back/Forward, then one section per kind of tool.
 * Shape is a tile over both rows: shapes drive the classes, the forms and the validation. SKOS: Scheme over Collection.
 * Classes: the class picker, one item per class and "+N" fill the remaining width in two rows. View: Group over Note.
 * The items come from the shapes (see ShapesPaletteProvider).
 */
@injectable()
export class CatenaryToolPalette extends KeyboardToolPalette {
    @inject(CommandService) protected readonly commands: CommandService;
    @inject(CommandRegistry) protected readonly registry: CommandRegistry;
    @inject(ViewHistory) protected readonly history: ViewHistory;
    @inject(SelectionModel) protected readonly elements: SelectionModel;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(ModelActions) protected readonly actions: ModelActions;

    protected historyButtons: [HTMLElement, string][] = [];
    protected listening = false;
    protected fitWidth = -1;

    /**
     * The class items change with the shapes. GLSP requests the items again on UpdateModel/SetModel only when the palette is
     * "dynamic" (a creation action with a dynamic ghost element), so set the flag here. A shapes change refreshes every view session.
     */
    protected override async setPaletteItems(): Promise<void> {
        await super.setPaletteItems();
        this.dynamic = true;
    }

    protected override initializeContents(containerElement: HTMLElement): void {
        super.initializeContents(containerElement);
        // A width change moves the classes between the rows.
        new ResizeObserver(() => {
            if (this.containerElement.clientWidth !== this.fitWidth) this.fitClasses();
        }).observe(this.containerElement);
    }

    /**
     * Header tools: Back and Forward (view history). No delete tool (Del, Ctrl+Del) and no search (Ctrl+T). The selection button is
     * not shown; it stays as the "clicked" target when the default tools are active.
     */
    protected override createHeaderTools(): HTMLElement {
        this.headerToolsButtonMapping.clear();
        const headerTools = document.createElement('div');
        headerTools.classList.add('header-tools');
        this.defaultToolsButton = this.createDefaultToolButton();
        this.headerToolsButtonMapping.set(0, this.defaultToolsButton);
        const button = (icon: string, title: string, command: string) => {
            const b = createIcon(icon);
            b.title = title;
            b.onclick = () => { if (this.registry.isEnabled(command)) void this.commands.executeCommand(command); };
            return b;
        };
        this.historyButtons = [
            [button('arrow-left', 'Back (Alt+Left, mouse back button)', ModelCommands.BACK.id), ModelCommands.BACK.id],
            [button('arrow-right', 'Forward (Alt+Right, mouse forward button)', ModelCommands.FORWARD.id), ModelCommands.FORWARD.id]
        ];
        headerTools.append(...this.historyButtons.map(([b]) => b));
        if (!this.listening) {
            this.listening = true;
            this.history.onDidChange(() => this.updateHistoryButtons());
        }
        this.updateHistoryButtons();
        return headerTools;
    }

    protected updateHistoryButtons(): void {
        for (const [b, command] of this.historyButtons) b.classList.toggle('catenary-disabled', !this.registry.isEnabled(command));
    }

    protected override createKeyboardToolButton(item: PaletteItem, tabIndex: number, buttonIndex: number): HTMLElement {
        const button = super.createKeyboardToolButton(item, tabIndex, buttonIndex);
        button.dataset.item = item.id;
        if (item.id.startsWith('class-')) button.classList.add('catenary-class-tool');
        if (item.id === 'node-shape') button.title = 'New shape: click on the canvas to place it';
        return button;
    }

    /** Moves the buttons into the sections (SECTIONS). The class section has the class picker first and "+N" last. */
    protected override createBody(): void {
        super.createBody();
        const body = this.bodyDiv!;
        const pick = (className: string, title: string, icon?: string) => {
            const b = document.createElement('div');
            b.classList.add('tool-button', className);
            b.title = title;
            if (icon) b.appendChild(createIcon(icon));
            b.onclick = () => void this.commands.executeCommand(ModelCommands.NEW_INSTANCE.id);
            return b;
        };
        const picker = pick('catenary-class-pick', 'New instance: pick a class (I on the canvas)', 'search');
        picker.insertAdjacentText('beforeend', 'class…');
        const classes = [picker, ...body.querySelectorAll<HTMLElement>('.catenary-class-tool'),
            pick('catenary-class-more', 'More classes: pick a class (I on the canvas)')];
        const sections = SECTIONS.map(([name, title, items]) => {
            const section = document.createElement('div');
            section.classList.add('catenary-palette-section', `catenary-palette-${name}`);
            section.title = title;
            const buttons = name === 'classes' ? classes : items.map(id => body.querySelector<HTMLElement>(`[data-item="${id}"]`));
            section.append(...buttons.filter((b): b is HTMLElement => !!b));
            return section;
        });
        // The GLSP groups (with their headers) are empty now; GLSP keeps the buttons by reference for the keyboard.
        body.replaceChildren(...sections, ...body.querySelectorAll(':scope > :not(.tool-group)'));
        this.fitWidth = -1;
        requestAnimationFrame(() => this.fitClasses());
    }

    /** At most CLASS_ROWS rows in the class section: the classes that do not fit are hidden, "+N" counts them. */
    protected fitClasses(): void {
        const container = this.containerElement;
        const section = container?.querySelector<HTMLElement>('.catenary-palette-classes');
        const classes = [...section?.querySelectorAll<HTMLElement>('.catenary-class-tool') ?? []];
        const more = section?.querySelector<HTMLElement>('.catenary-class-more');
        if (!section || !more || !classes.length || !container.isConnected || !container.clientWidth) return;
        this.fitWidth = container.clientWidth;
        classes.forEach(b => b.classList.remove('catenary-overflow'));
        more.classList.add('catenary-overflow');
        // align-items: center: the items of one row have the same center. The first item of the section is on row 1.
        const center = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
        const first = section.firstElementChild as HTMLElement;
        const pitch = first.offsetHeight + 2;
        const limit = center(first) + (CLASS_ROWS - 0.5) * pitch;
        if (center(classes[classes.length - 1]) < limit) return;
        more.classList.remove('catenary-overflow');
        let hidden = 0;
        for (let i = classes.length - 1; i >= 0 && (hidden === 0 || center(more) >= limit); i--) {
            classes[i].classList.add('catenary-overflow');
            more.textContent = `+${++hidden}`;
        }
    }

    protected override onClickCreateToolButton(button: HTMLElement, item: PaletteItem): (ev: MouseEvent) => void {
        const arm = super.onClickCreateToolButton(button, item);
        return ev => {
            // Group with boxes selected on this canvas: a group around them at once (no click on the canvas).
            if (item.id === 'group' && this.boxesSelected()) return void this.commands.executeCommand(ModelCommands.NEW_GROUP.id);
            const classIri = (item.actions[0] as { args?: { classIri?: unknown } } | undefined)?.args?.classIri;
            if (typeof classIri === 'string') this.actions.useClass(classIri);
            arm(ev);
        };
    }

    /** True when the selection was made on this canvas and has a box (card, group, note, reference, collection, value set). */
    protected boxesSelected(): boolean {
        const view = viewIdOfUri(this.editorContext.sourceUri ?? '');
        const sel = this.elements.selection;
        if (!view || sel.view !== view || !sel.ids.length) return false;
        const s = this.elements.resolved;
        return [s.instances, s.groups, s.notes, s.references, s.collections, s.shapes, s.valueSets].some(ids => ids.length > 0);
    }
}

/** The GLSP focus tracker shows a "Currently focused: …" toast on each focus change. No listeners, no toast. */
@injectable()
export class SilentFocusTracker extends FocusTrackerTool {
    override enable(): void { /* disabled */ }
}

const catenaryToolPaletteModule = new FeatureModule((_bind, _unbind, _isBound, rebind) => {
    rebind(KeyboardToolPalette).to(CatenaryToolPalette).inSingletonScope();
    rebind(FocusTrackerTool).to(SilentFocusTracker).inSingletonScope();
}, { featureId: Symbol('catenaryToolPalette'), requires: accessibilityModule });

@injectable()
export class ViewDiagramConfiguration extends GLSPDiagramConfiguration {
    diagramType = DIAGRAM_TYPE;

    /** No zoom-out limit (GLSP: 0.1), so that a fit shows a large view. 0.001: a zoom of 0 has no scale. The zoom-in limit stays. */
    protected override createDiagramOptionsModule(options: IDiagramOptions): FeatureModule {
        return createDiagramOptionsModule(options, { zoomLimits: { min: 0.001, max: 20 } });
    }

    configureContainer(container: Container, ...containerConfiguration: ContainerConfiguration): Container {
        // accessibilityModule brings a keyboard-aware tool palette that replaces the default one.
        return initializeDiagramContainer(container, helperLineModule, gridModule, viewDiagramModule, ...containerConfiguration,
            { add: [accessibilityModule, catenaryToolPaletteModule, selectionForwarderModule, copyPasteModule, marqueeModule], remove: [toolPaletteModule] });
    }
}
