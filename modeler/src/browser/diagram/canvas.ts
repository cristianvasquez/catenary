// DOM interactions on a view editor that GLSP does not provide:
// the halo buttons of the only selected element (card-chrome.ts), among them the link button: drag it to draw a relation (with a
// picker on empty canvas; released on a note: an arrow), the arrow button of a note: drag it to another element (an arrow), drag of an edge end (or of the edge line: its nearest end) to another card or side, drop from the
// Model Explorer, Shift+click on a card or group (add to or remove from the selection), and keys (F2, Ctrl+Del). Pickers open next to the element (popup-picker.ts).
// Shapes views: a card lists its properties as rows (as a collection lists its members). "+ attribute" types a new one in place (Enter:
// the next one, Tab: pick its value); a click on the value of a row picks another one, on a cardinality cycles it; a double click on a
// path (row or edge label) edits it; ⇥ or a drag of the row out of the card shows the property as an edge, its pill where it is dropped.
// The link button draws a property "unnamed property N" (to a card or a value set: that target; to empty canvas: a picker with "+ New node
// shape", "+ New concept scheme", …, the pill or the new target at the release point). No path is asked.
// Value set nodes: double click on a concept renames it, × removes it, "+ concept" adds one. The logic handle of a selected edge drags a
// logical constraint to another edge; a dragged edge end retargets the property.

import { SelectAction } from '@eclipse-glsp/client';
import { GLSPDiagramWidget, TheiaGLSPContextMenu } from '@eclipse-glsp/theia-integration';
import { CommandRegistry, MessageService, URI } from '@theia/core';
import { ApplicationShell, ContextMenuRenderer, FrontendApplicationContribution, OpenerService, open } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { COMMON_DATATYPES, DEFAULT_SIZE, GestureInfo, LATENT_SUFFIX, Point, Rect, Side, TYPES, TargetList, ViewGesture, compactIri, formatPath, ownerOfLabel } from '@catenary/model';
import { VIEW_SCHEME } from '../../common/protocol';
import { ActionService, whenActionsKnown } from '../action-service';
import { ModelActions } from '../actions';
import { ModelCommands } from '../commands';
import { ModelFrontend } from '../model-client';
import { NoteEditor } from '../notes/note-editor';
import { SelectionModel } from '../selection-model';
import { selectionInDiagram } from './diagram-ids';
import { ViewEditors, viewIdOf } from './view-editors';
import { nearestSide } from './edge-chrome';
import { inlineInput } from './inline-input';
import { editCanvasName } from './name-edit';
import { PendingMemberAction } from './pending-members';

/** Drag data types from the Model Explorer. */
export const DND_INSTANCES = 'application/x-catenary-instances';
export const DND_CLASS = 'application/x-catenary-class';
export const DND_RELATIONS = 'application/x-catenary-relations';
export const DND_VIEW = 'application/x-catenary-view';
/** Files dragged from the Theia file navigator (ApplicationShell.setDraggedEditorUris). */
const DND_FILES = 'theia-editor-dnd';
/** Elements that an arrow can connect. */
const BOXES = '.catenary-card, .catenary-note, .catenary-group, .catenary-view-reference, .catenary-collection, .catenary-leaf';
/** Elements that a connect gesture dims when they are not its targets (spec/ui-manifest.hs §5.5 Connect drags). */
const CONNECTABLE = `${BOXES}, .catenary-edge, .catenary-logic, .shape-row, .member-row`;

/**
 * A connect gesture (CanvasInteractions.connectDrag): its targets and what a release does. The data of the gesture comes from the
 * backend when it starts (`info`, RPC `viewGesture`); the checks during the drag are synchronous on it.
 */
interface ConnectGesture {
    /** The elements that can be targets. */
    selector: string;
    /** The answer of the backend for this gesture. */
    info: Promise<GestureInfo>;
    /** Why an element of `selector` is not a target; undefined: it is one. Decides the dimming, the drop and the message on release. */
    problem: (el: Element, info: GestureInfo) => string | undefined;
    /** The element the drag starts from: not dimmed, no message on release on it (or on its container). */
    source?: Element | null;
    /** Start of the line (client coordinates). Default: the point of `start`. */
    from?: { x: number; y: number };
    /** Release on a target. */
    drop: (e: MouseEvent, target: Element, info: GestureInfo) => void;
    /** Release less than 8 px from `from`, not on a target. */
    click?: (e: MouseEvent, info: GestureInfo) => void;
    /** Release on empty canvas. */
    empty?: (e: MouseEvent, info: GestureInfo) => void;
}

/** Why a candidate of a gesture is not a target (GestureInfo); undefined: it is one. */
function problemIn(info: GestureInfo, list: TargetList, id: string): string | undefined {
    const p = info.problems[list]?.[id];
    return p === '' ? undefined : p ?? 'The view editor has no answer from the backend for this gesture.';
}

/**
 * Give the focus to a view editor after a press that the canvas handles itself (preventDefault: no native focus). The base div has no
 * tabindex, so it cannot take the focus; the svg can. With the focus outside, FocusedSelectionForwarder ignores the new selection.
 */
function focusCanvas(w: GLSPDiagramWidget): void {
    document.getElementById(w.viewerOptions.baseDiv)?.querySelector<SVGSVGElement>('svg.sprotty-graph')?.focus();
}

@injectable()
export class CanvasInteractions implements FrontendApplicationContribution {
    @inject(ApplicationShell) protected readonly shell: ApplicationShell;
    @inject(ViewEditors) protected readonly editors: ViewEditors;
    @inject(ModelActions) protected readonly actions: ModelActions;
    @inject(ModelFrontend) protected readonly model: ModelFrontend;
    @inject(CommandRegistry) protected readonly commands: CommandRegistry;
    @inject(ContextMenuRenderer) protected readonly contextMenu: ContextMenuRenderer;
    @inject(NoteEditor) protected readonly noteEditor: NoteEditor;
    @inject(SelectionModel) protected readonly selection: SelectionModel;
    @inject(OpenerService) protected readonly openers: OpenerService;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(ActionService) protected readonly actionService: ActionService;
    protected readonly installed = new WeakSet<GLSPDiagramWidget>();

    onStart(): void {
        this.shell.onDidAddWidget(w => {
            if (w instanceof GLSPDiagramWidget && w.uri.scheme === VIEW_SCHEME) this.install(w);
        });
        for (const w of this.editors.all()) this.install(w);
    }

    onDidInitializeLayout(): void {
        for (const w of this.editors.all()) this.install(w);
    }

    protected install(w: GLSPDiagramWidget): void {
        if (this.installed.has(w)) return;
        this.installed.add(w);
        const host = w.node;
        const idOf = (el: Element | null, selector: string) => this.idOf(w, el, selector);
        let referencePress: { id: string; x: number; y: number } | undefined;

        // Capture phase: runs before the GLSP mouse tools, so that a drag on the handle does not move the card.
        host.addEventListener('mousedown', e => {
            const target = e.target as Element;
            if (e.button !== 0 || target.closest?.('.catenary-name-input, .catenary-embedded-input')) return;
            if (e.detail === 2) {
                const note = idOf(target, '.catenary-note');
                if (note) {
                    e.preventDefault();
                    e.stopPropagation();
                    void this.noteEditor.open(viewIdOf(w), note, target.closest('.catenary-note') ?? undefined);
                    return;
                }
            }
            const reference = idOf(target, '.catenary-view-reference');
            referencePress = reference ? { id: reference, x: e.clientX, y: e.clientY } : undefined;
            if (this.shapesPress(w, target, e)) return;
            const halo = target.closest?.('.halo-action');
            const cardinality = target.closest?.('[data-card]');
            const property = cardinality ? idOf(target, '.catenary-edge') ?? idOf(target, '.shape-row') : undefined;
            if (property && e.detail === 1) {
                e.preventDefault();
                e.stopPropagation();
                void this.actions.cycleCardinality(property, viewIdOf(w));
                return;
            }
            if (target.closest?.('.target-handle')) {
                const from = idOf(target, '.catenary-edge');
                if (!from) return;
                e.preventDefault();
                e.stopPropagation();
                this.targetDrag(w, from, e);
                return;
            }
            const logic = target.closest?.('.logic-handle');
            if (logic) {
                const from = idOf(target, '.catenary-edge');
                if (!from) return;
                e.preventDefault();
                e.stopPropagation();
                this.logicDrag(w, from, e);
                return;
            }
            if (halo) {
                const box = halo.closest('.catenary-halo')?.getAttribute('data-element');
                if (box === null || box === undefined) return;
                const id = box && this.editors.elementOf(w, box);
                e.preventDefault();
                e.stopPropagation();
                this.haloAction(w, id, halo, e);
            } else if (target.closest?.('.catenary-collection .member-take-out, .catenary-collection .member-remove, .catenary-collection .member-add')) {
                // Collection rows: ➟ takes the member out, × removes its card from the view, "+ member" adds an instance.
                const collection = idOf(target, '.catenary-collection'), member = target.closest('.member-row')?.getAttribute('data-member');
                if (!collection) return;
                e.preventDefault();
                e.stopPropagation();
                if (target.closest('.member-add')) this.addMember(w, collection, target.closest('.member-add')!);
                else if (member && target.closest('.member-take-out')) void this.actions.uncollect(viewIdOf(w), [collection], [member]);
                else if (member) void this.actions.removeFromView(viewIdOf(w), member);
            } else if (target.classList?.contains('edge-end')) {
                const relation = idOf(target, '.catenary-edge');
                if (!relation) return;
                e.preventDefault();
                e.stopPropagation();
                const end = target.getAttribute('data-end') === 'source' ? 'source' : 'target';
                const other = target.parentElement?.querySelector(`.edge-end[data-end="${end === 'source' ? 'target' : 'source'}"]`)?.getBoundingClientRect();
                this.endDrag(w, relation, end, other ? { x: other.left + other.width / 2, y: other.top + other.height / 2 } : { x: e.clientX, y: e.clientY }, e);
            } else if (e.shiftKey && !target.closest?.('.catenary-resize-handle, .catenary-resize-grip') && (idOf(target, '.catenary-card') ?? idOf(target, '.catenary-group'))) {
                // GLSP adds with Ctrl only; with a selection, its Shift+click replaces the selection.
                e.preventDefault();
                e.stopPropagation();
                this.toggle(w, (idOf(target, '.catenary-card') ?? idOf(target, '.catenary-group'))!);
            } else if ((target.classList?.contains('hit') || target.classList?.contains('line')) && target.parentElement?.classList.contains('catenary-edge')) {
                // A click selects the edge; a drag moves its nearest end. GLSP does not get the press: it would pan the canvas.
                const relation = idOf(target, '.catenary-edge');
                const line = target.parentElement.querySelector<SVGPathElement>('.line');
                if (!relation || !line) return;
                e.preventDefault();
                e.stopPropagation();
                // An arrow has no ends to drag: a press only selects it.
                this.lineDrag(w, relation, line, e, !target.parentElement.classList.contains('arrow-edge'));
            }
        }, true);

        // The halo is in the root layer (CatenaryGraphView): for GLSP, a mouse up on it is a click on empty canvas, which clears the selection.
        for (const type of ['mouseup', 'click', 'dblclick'] as const) {
            host.addEventListener(type, e => { if ((e.target as Element).closest?.('.catenary-halo')) e.stopPropagation(); }, true);
        }

        host.addEventListener('dblclick', e => {
            const t = e.target as Element;
            if (t.closest?.('.catenary-name-input, .catenary-embedded-input')) return;
            const name = t.closest?.('.card-name, .shape-name, .vs-name, .group-label');
            const named = name ? idOf(t, '.catenary-card') ?? idOf(t, '.catenary-group') : undefined;
            if (named && editCanvasName(w, named, viewIdOf(w), this.editors, this.model)) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // Shapes view, typed in place: a concept of a value set, the path of an edge (its label) or of a row, the target of a pill,
            // the target class of a node.
            const chip = t.closest?.('.valueset-card .member-row');
            const chipSet = chip ? idOf(t, '.valueset-card') : undefined;
            if (chip && chipSet) {
                e.preventDefault();
                e.stopPropagation();
                const uri = chip.getAttribute('data-member')!, r = chip.getBoundingClientRect();
                // The label of the row, from the value set card of the diagram graph.
                const members = (this.shown(w, chipSet)?.members ?? []) as { uri: string; label: string }[];
                const label = members.find(m => m.uri === uri)?.label ?? '';
                // Selection can redraw the card on this double-click. Mount after that redraw.
                requestAnimationFrame(() => {
                    const card = this.nodeOf(w, chipSet);
                    const current = [...(card?.querySelectorAll('.member-row') ?? [])].find(c => c.getAttribute('data-member') === uri);
                    if (current) inlineInput({ at: { x: r.left, y: r.top + r.height / 2 }, inside: current.querySelector('.member-label') ?? current,
                        value: label, placeholder: 'concept label', onCommit: text => this.actions.renameConcept(uri, text) });
                });
                return;
            }
            const property = t.closest?.('.edge-label, .row-path') ? idOf(t, '.catenary-edge') ?? idOf(t, '.shape-row') : undefined;
            const leaf = idOf(t, '.catenary-leaf');
            const shapeClass = t.closest?.('.shape-class') ? idOf(t, '.catenary-card') : undefined;
            if (property || leaf || shapeClass) {
                e.preventDefault();
                e.stopPropagation();
                const at = { x: e.clientX, y: e.clientY }, view = viewIdOf(w);
                // The path, target or target class comes from the backend; the double-click can redraw the element before it arrives.
                const live = (el: Element | null | undefined, id: string, selector: string) => el?.isConnected ? el : this.nodeOf(w, id)?.querySelector(selector) ?? undefined;
                if (property) {
                    const inside = t.closest('.row-path, .edge-label');
                    void this.gesture(w, { kind: 'element', id: property }).then(({ property: p }) => {
                        if (!p) return;
                        inlineInput({ at, inside: live(inside, property, '.row-path, .edge-label'), value: formatPath(p.path), placeholder: 'property name, prefix:local or <iri>', options: this.actions.pathOptions(),
                            onCommit: text => this.actions.setPathText(property, text, view) });
                    });
                } else if (leaf) {
                    const id = ownerOfLabel(leaf), inside = t.closest('.catenary-leaf')?.querySelector('text, .vs-name');
                    void Promise.all([this.gesture(w, { kind: 'element', id }), this.model.service.shapes()]).then(([{ property: p }, shapes]) => {
                        if (!p) return;
                        inlineInput({ at, inside: live(inside, leaf, 'text, .vs-name'), value: this.actions.targetText(p.range, shapes), placeholder: 'target: a class name, xsd:string, any, a concept scheme, prefix:local; "a | b": one of', options: this.actions.targetOptions(),
                            onCommit: text => this.actions.setTargetText(id, text, view) });
                    });
                } else {
                    const inside = t.closest('.shape-class');
                    void this.gesture(w, { kind: 'element', id: shapeClass! }).then(({ nodeShape: s }) => {
                        inlineInput({ at, inside: live(inside, shapeClass!, '.shape-class'), value: s?.targetClass ? compactIri(s.targetClass) : '', placeholder: 'target class: name, prefix:local or <iri>', options: this.model.meta.classes.map(c => compactIri(c.iri)),
                            onCommit: text => this.actions.setTargetClassText(shapeClass!, text) });
                    });
                }
                return;
            }
            const id = idOf(t, '.catenary-note');
            if (!id) return;
            e.preventDefault();
            e.stopPropagation();
            void this.noteEditor.open(viewIdOf(w), id, (e.target as Element).closest('.catenary-note') ?? undefined);
        }, true);

        // A plain click follows a view reference. Shift/Ctrl/Meta click only selects it, and a drag only moves it.
        host.addEventListener('click', e => {
            const target = e.target as Element;
            const id = idOf(target, '.catenary-view-reference');
            const press = referencePress;
            referencePress = undefined;
            if (!id || !press || press.id !== id || e.shiftKey || e.ctrlKey || e.metaKey
                || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return;
            if (this.shown(w, id)?.type !== TYPES.VIEW_REFERENCE) return;
            e.preventDefault();
            e.stopPropagation();
            // The stored reference (target view, or file: path and state) comes from the backend. Let GLSP finish the source-view click
            // before Theia activates the target editor. A file: its open handler (a view file: its canvas; the workspace file: its
            // settings; another file: text). A broken reference: a message.
            void this.gesture(w, { kind: 'element', id }).then(({ box: reference }) => {
                if (reference?.kind !== 'reference') return;
                if (reference.target) setTimeout(() => this.editors.open(reference.target!), 0);
                else if (reference.broken) this.messages.warn(`${reference.file}: the file is not on disk (moved or removed).`);
                else if (reference.path) setTimeout(() => void open(this.openers, URI.fromFilePath(reference.path!)), 0);
            });
        }, true);

        // Stop propagation: the Theia main dock panel sets dropEffect 'link' on bubble, which does not match
        // effectAllowed 'copy' of the explorer, and the browser then cancels the drop.
        const accept = (e: DragEvent) => {
            const types = e.dataTransfer?.types ?? [];
            if (types.includes(DND_INSTANCES) || types.includes(DND_CLASS) || types.includes(DND_RELATIONS) || types.includes(DND_VIEW)
                || types.includes(DND_FILES)) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer!.dropEffect = 'copy';
            }
        };
        host.addEventListener('dragenter', accept, true);
        host.addEventListener('dragover', accept, true);
        host.addEventListener('drop', e => {
            const ids = e.dataTransfer?.getData(DND_INSTANCES);
            const cls = e.dataTransfer?.getData(DND_CLASS);
            const relations = e.dataTransfer?.getData(DND_RELATIONS);
            const targetView = e.dataTransfer?.getData(DND_VIEW);
            // Files from the file navigator (ADR 0004): a view file is a view reference, another file a file reference.
            const files = (e.dataTransfer?.getData(DND_FILES) ?? '').split('\n').filter(Boolean).map(u => new URI(u).path.fsPath());
            if (!ids && !cls && !relations && !targetView && !files.length) return;
            e.preventDefault();
            e.stopPropagation();
            const at = this.editors.toModel(w, e.clientX, e.clientY);
            const view = viewIdOf(w);
            if (cls) this.actions.newInstance(cls, view, at);
            else if (relations) this.actions.showRelations(view, relations.split('\n').filter(Boolean), at);
            else if (targetView) this.actions.addViewReference(view, targetView, at);
            else if (files.length) void this.actions.addFileReferences(view, files, at);
            else this.actions.addToView(view, ids!.split('\n').filter(Boolean), at);
        }, true);

        // Model point of the last right click: New Instance in the context menu places the card there.
        host.addEventListener('contextmenu', e => { this.editors.menuAt.set(w, this.editors.toModel(w, e.clientX, e.clientY)); }, true);

        // Client point of the pointer: New Instance (key I, palette class picker) places the card there.
        // Only on the graph: the tool palette is in the same host.
        host.addEventListener('pointermove', e => {
            if ((e.target as Element | null)?.closest?.('.sprotty-graph')) this.editors.pointerAt.set(w, { x: e.clientX, y: e.clientY });
            else this.editors.pointerAt.delete(w);
        }, true);
        host.addEventListener('pointerleave', () => { this.editors.pointerAt.delete(w); });

        // Keys of the element operations: same commands as the context menu (commands.ts).
        host.addEventListener('keydown', e => {
            // I: the class picker, then a new instance at the pointer. Not in a text input.
            if (e.key === 'i' && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable]')) {
                e.preventDefault();
                e.stopPropagation();
                void this.commands.executeCommand(ModelCommands.NEW_INSTANCE.id);
                return;
            }
            // F2 on an edge of a shapes view edits its path.
            const f2 = this.commands.isVisible(ModelCommands.RENAME.id) ? ModelCommands.RENAME : ModelCommands.EDIT_PATH;
            const command = e.key === 'F2' ? f2 : e.key === 'Delete' && (e.ctrlKey || e.metaKey) ? ModelCommands.DELETE_FROM_MODEL : undefined;
            if (!command || !this.commands.isVisible(command.id)) return;
            e.preventDefault();
            e.stopPropagation();
            void this.commands.executeCommand(command.id);
        }, true);
    }

    /** The DOM node of an element (by element id: its card or edge, by the id of its placement) or of a box (by its id). */
    protected nodeOf(w: GLSPDiagramWidget, id: string): HTMLElement | null {
        return document.getElementById(`${w.viewerOptions.baseDiv}_${this.editors.placementOf(w, id)}`);
    }

    /**
     * Element id of the closest `selector` ancestor of `el` in this view editor. The diagram id of a card or a placed edge is the
     * id of its placement: it gives its element (the diagram graph, ViewEditors.elementOf); other ids stay (a mark: its placement).
     */
    protected idOf(w: GLSPDiagramWidget, el: Element | null, selector: string): string | undefined {
        const baseDiv = w.viewerOptions.baseDiv;
        const g = el?.closest(selector);
        const id = g?.id?.startsWith(baseDiv + '_') ? g.id.slice(baseDiv.length + 1) : undefined;
        return id === undefined ? undefined : this.editors.elementOf(w, id);
    }

    /** The side of `card` nearest to the pointer. */
    protected sideAt(card: Element, e: MouseEvent): Side {
        return nearestSide((card.querySelector('.body') ?? card).getBoundingClientRect(), { x: e.clientX, y: e.clientY });
    }

    /**
     * Press that becomes a drag after `threshold` px of movement once `ready` is true: `drag` runs with that move event. Else, on
     * release: `release`, with `moved` true when the pointer moved `threshold` px (but `ready` stayed false).
     */
    protected pressDrag(start: MouseEvent, drag: (e: MouseEvent) => void, release: (e: MouseEvent, moved: boolean) => void,
        ready: (e: MouseEvent) => boolean = () => true, threshold = 6): void {
        let moved = false;
        const move = (e: MouseEvent) => {
            if (Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < threshold) return;
            moved = true;
            if (!ready(e)) return;
            stop();
            drag(e);
        };
        const up = (e: MouseEvent) => {
            stop();
            release(e, moved);
        };
        const stop = () => {
            window.removeEventListener('mousemove', move, true);
            window.removeEventListener('mouseup', up, true);
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
    }

    /**
     * Connect gesture `g` (spec/ui-manifest.hs §5.5 Connect drags): the elements of `g.selector` without a problem are the targets
     * (dragLine). Release on a target: `g.drop`. Else: `g.click` near the start; on a dimmed element (not the source): the reason, as a
     * message; on empty canvas: `g.empty`; outside the view: nothing.
     */
    protected connectDrag(w: GLSPDiagramWidget, start: MouseEvent, g: ConnectGesture): void {
        const from = g.from ?? { x: start.clientX, y: start.clientY };
        const info = g.info.catch((): GestureInfo => ({ problems: {} }));
        const targets = info.then(i => [...w.node.querySelectorAll(g.selector)].filter(el => !g.problem(el, i)));
        this.dragLine(w, from, start, async (e, target) => {
            const i = await info;
            if (target) return g.drop(e, target, i);
            if (g.click && Math.hypot(e.clientX - from.x, e.clientY - from.y) < 8) return g.click(e, i);
            const under = document.elementFromPoint(e.clientX, e.clientY);
            if (!under || !w.node.contains(under)) return;
            if (!under.closest(CONNECTABLE)) return g.empty?.(e, i);
            const el = under.closest(g.selector);
            const reason = el && !(g.source && el.contains(g.source)) ? g.problem(el, i) : undefined;
            if (reason) this.messages.warn(reason);
        }, targets, g.source);
    }

    /** The answer of the backend for a gesture of this view editor (RPC `viewGesture`): the problems of its candidates, the facts of its element. */
    protected gesture(w: GLSPDiagramWidget, g: ViewGesture): Promise<GestureInfo> {
        return this.model.service.viewGesture(viewIdOf(w), g).catch((): GestureInfo => ({ problems: {} }));
    }

    /** The ids of the elements of `selector` in this view editor, by `id`, once each: the candidates of a gesture. */
    protected candidates(w: GLSPDiagramWidget, selector: string, id: (el: Element) => string): string[] {
        return [...new Set([...w.node.querySelectorAll(selector)].map(id))];
    }

    /**
     * Drag of an edge end: dashed line from the other end (`from`, client coordinates) to the pointer. Release on another card:
     * the relation moves to it; on the same card: only the side changes. Both pin the side nearest to the release point.
     * A property shape: its target end goes to another node shape or value set; its source end has no target.
     */
    protected endDrag(w: GLSPDiagramWidget, relation: string, end: 'source' | 'target', from: { x: number; y: number }, start: MouseEvent): void {
        const card = (el: Element) => this.idOf(w, el, '.catenary-card') ?? '';
        const info = this.gesture(w, { kind: 'reconnect', relation, end, cards: this.candidates(w, '.catenary-card', card) });
        this.connectDrag(w, start, {
            selector: '.catenary-card', source: this.nodeOf(w, relation), from, info,
            problem: (el, i) => problemIn(i, 'cards', card(el)),
            drop: (e, el, i) => {
                if (i.property) void this.actions.retarget(relation, card(el), viewIdOf(w));
                else void this.actions.reconnect(relation, end, card(el), viewIdOf(w), this.sideAt(el, e));
            },
        });
    }

    /** Mouse down on the edge line: after 6 px of movement, drag the end nearest to the press point (see endDrag); else select the edge. */
    protected lineDrag(w: GLSPDiagramWidget, relation: string, line: SVGPathElement, start: MouseEvent, movable = true): void {
        const m = line.getScreenCTM();
        if (!m) return;
        const screen = (t: number) => { const p = line.getPointAtLength(t); return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }; };
        const p1 = screen(0), p2 = screen(line.getTotalLength());
        const d = (p: { x: number; y: number }) => Math.hypot(p.x - start.clientX, p.y - start.clientY);
        const end = d(p1) <= d(p2) ? 'source' : 'target';
        this.pressDrag(start, e => this.endDrag(w, relation, end, end === 'source' ? p2 : p1, e), e => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) this.toggle(w, relation);
            else {
                w.actionDispatcher.dispatch(SelectAction.create({ selectedElementsIDs: [this.editors.placementOf(w, relation)], deselectedElementsIDs: true }));
                focusCanvas(w);
            }
        }, () => movable);
    }

    /** The part of the selection that this view editor shows. */
    protected selectedIn(w: GLSPDiagramWidget): string[] {
        const ids = this.editors.diagram(w);
        return ids ? selectionInDiagram(ids, this.selection.selection, viewIdOf(w), (view, id) => this.editors.elementIn(view, id)) : [];
    }

    /** Add an element to the selection, or remove it if it is selected. The view editor gets the focus: the selection goes to the panels. */
    protected toggle(w: GLSPDiagramWidget, element: string): void {
        const id = this.editors.placementOf(w, element);   // the diagram id
        const selected = this.selectedIn(w).includes(id);
        w.actionDispatcher.dispatch(SelectAction.create({ selectedElementsIDs: selected ? [] : [id], deselectedElementsIDs: selected ? [id] : [] }));
        focusCanvas(w);
    }

    /** … halo button: the context menu of the view editor, below the button. "New … here" commands place at the button. */
    protected elementMenu(w: GLSPDiagramWidget, button: Element): void {
        const b = button.getBoundingClientRect();
        this.editors.menuAt.set(w, this.editors.toModel(w, b.left, b.bottom));
        // The menu opens after the actions of the selection are known (action-menus.ts).
        void whenActionsKnown(this.actionService, this.actionService.selectionTarget()).then(() => this.contextMenu.render({
            menuPath: TheiaGLSPContextMenu.CONTEXT_MENU, anchor: { x: b.left, y: b.bottom + 6 }, context: w.node,
            onHide: () => focusCanvas(w)
        }));
    }

    /** A halo button of the only selected element `id` ('' for several). The commands act on the selection. */
    protected haloAction(w: GLSPDiagramWidget, id: string, button: Element, e: MouseEvent): void {
        const run = (command: { id: string }) => void this.commands.executeCommand(command.id);
        const b = button.getBoundingClientRect();
        switch (button.getAttribute('data-action')) {
            case 'remove': return run(ModelCommands.REMOVE_FROM_VIEW);
            case 'collect': return run(ModelCommands.COLLECT);
            case 'uncollect': return run(ModelCommands.UNCOLLECT);
            case 'reveal': return run(ModelCommands.SELECT_IN_EXPLORER);
            case 'menu': return this.elementMenu(w, button);
            case 'link': case 'linkIn': {
                const dir = button.getAttribute('data-action') === 'link' ? 'out' : 'in';
                return this.isNodeShape(w, id) ? this.shapeLinkDrag(w, id, e, button, dir) : this.linkDrag(w, id, e, button, dir);
            }
            case 'arrow': return this.arrowDrag(w, id, e);
            case 'expandIn': {
                const shape = this.isNodeShape(w, id), anchor = { x: b.left - 8, y: b.top };
                return void this.gesture(w, { kind: 'element', id }).then(i => {
                    const at = this.beside(w, i.box, button, 'in');
                    return shape ? this.actions.expandShape(id, viewIdOf(w), at, anchor) : this.actions.expand('in', id, viewIdOf(w), at, anchor);
                });
            }
            case 'expandOut': return void this.gesture(w, { kind: 'element', id })
                .then(i => this.actions.expand('out', id, viewIdOf(w), this.beside(w, i.box, button, 'out'), { x: b.right + 8, y: b.top }));
        }
    }

    /** The element `id` has a node shape card in this view editor (diagram graph). */
    protected isNodeShape(w: GLSPDiagramWidget, id: string): boolean {
        return this.editors.diagram(w)?.get(this.editors.placementOf(w, id))?.type === TYPES.SHAPE;
    }

    /** The schema fields of the diagram element that shows `id` in this view editor (its card or edge, else the element with that id). */
    protected shown(w: GLSPDiagramWidget, id: string): Record<string, unknown> | undefined {
        return this.editors.diagram(w)?.get(this.editors.placementOf(w, id));
    }

    /**
     * Model point (center) for a new or added card next to `box`, the stored box of an element of the view (GestureInfo.box): 100 px
     * right (out) or left (in) of it. Without a box (not stored yet): next to the halo `button`.
     */
    protected beside(w: GLSPDiagramWidget, box: Rect | undefined, button: Element, direction: 'in' | 'out'): Point {
        const b = button.getBoundingClientRect();
        const r = box ?? { ...this.editors.toModel(w, b.left, b.top), width: 0, height: 0 };
        const dx = 100 + DEFAULT_SIZE.width / 2;
        return { x: direction === 'out' ? r.x + r.width + dx : r.x - dx, y: r.y + r.height / 2 };
    }

    /**
     * Connect gesture (spec/ui-manifest.hs §5.5 Connect drags): dashed line from `from` (client coordinates) to the pointer. During the
     * drag, every element of the view (CONNECTABLE) that is not in `targets`, does not contain one and is not inside one is dimmed; the
     * `source` stays. The target under the pointer is highlighted. `drop` runs on release, with that target or undefined: the same set
     * decides the dimming and the drop.
     */
    protected dragLine(w: GLSPDiagramWidget, from: { x: number; y: number }, start: MouseEvent, drop: (e: MouseEvent, target: Element | undefined) => void,
        targets: Promise<Element[]>, source?: Element | null): void {
        const host = w.node;
        const box = host.getBoundingClientRect();
        const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        overlay.classList.add('catenary-connect-overlay');
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.classList.add('connect-line');
        overlay.appendChild(line);
        host.appendChild(overlay);
        document.body.classList.add('catenary-grabbing');
        line.setAttribute('x1', String(from.x - box.left));
        line.setAttribute('y1', String(from.y - box.top));
        // The targets come with the answer of the backend; until then nothing is dimmed and nothing is a target.
        const valid = new Set<Element>();
        const dimmed = new Set<Element>();
        let done = false;
        const ready = targets.then(ts => {
            if (done) return;
            ts.forEach(t => valid.add(t));
            // Kept: the targets, the source, their ancestors (a card with a target row) and their descendants (the rows of a target card).
            const kept = new Set<Element>();
            for (const t of source ? [...ts, source] : ts) for (let a: Element | null = t; a && a !== host; a = a.parentElement) kept.add(a);
            // Document order: an ancestor comes first, so a part of a dimmed element is not dimmed twice.
            const inside = (el: Element) => {
                for (let a = el.parentElement; a && a !== host; a = a.parentElement) if (valid.has(a) || a === source || dimmed.has(a)) return true;
                return false;
            };
            for (const el of host.querySelectorAll(CONNECTABLE)) if (!kept.has(el) && !inside(el)) dimmed.add(el);
            dimmed.forEach(el => el.classList.add('connect-dimmed'));
        });
        host.classList.add('connect-dragging');
        // The first target in the stack under the pointer: parallel edges overlap, a dimmed element can cover a target.
        const targetAt = (e: MouseEvent): Element | undefined => {
            for (const el of document.elementsFromPoint(e.clientX, e.clientY))
                for (let a: Element | null = el; a && a !== host; a = a.parentElement) if (valid.has(a)) return a;
            return undefined;
        };
        let hover: Element | undefined;
        let last = start;
        const move = (e: MouseEvent) => {
            last = e;
            line.setAttribute('x2', String(e.clientX - box.left));
            line.setAttribute('y2', String(e.clientY - box.top));
            const target = targetAt(e);
            if (target !== hover) {
                hover?.classList.remove('drop-target');
                hover = target;
                hover?.classList.add('drop-target');
            }
        };
        move(start);
        void ready.then(() => { if (!done) move(last); });
        const up = (e: MouseEvent) => {
            window.removeEventListener('mousemove', move, true);
            window.removeEventListener('mouseup', up, true);
            e.stopPropagation();
            // A release before the answer: the drop waits for it.
            void ready.then(() => {
                done = true;
                hover?.classList.remove('drop-target');
                dimmed.forEach(el => el.classList.remove('connect-dimmed'));
                host.classList.remove('connect-dragging');
                overlay.remove();
                document.body.classList.remove('catenary-grabbing');
                drop(e, targetAt(e));
            });
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
    }

    /**
     * Link (+) button of a node shape, as the link button of an instance card: to another card or a value set node, a
     * property "unnamed property N" to it; to empty canvas, a picker for the target (or a new node shape or value set there). No name is
     * asked: rename the path later (double-click, F2, Properties). The new property is an edge, its pill at the release point.
     * A click on the halo `button`: the empty-canvas picker, the target right of the card.
     * `dir` 'in' (incoming button): the other node shape owns the property, `source` is its target; on empty canvas or a click, a
     * picker of node shapes (existing or new), left of the card on a click.
     */
    protected shapeLinkDrag(w: GLSPDiagramWidget, source: string, start: MouseEvent, button: Element, dir: 'out' | 'in' = 'out'): void {
        const view = viewIdOf(w);
        const canvas = (at: Point, e: MouseEvent) => void (dir === 'out'
            ? this.actions.linkShapeToCanvas(source, view, at, { x: e.clientX, y: e.clientY })
            : this.actions.linkShapeInToCanvas(source, view, at, { x: e.clientX, y: e.clientY }));
        const card = (el: Element) => this.idOf(w, el, '.catenary-card') ?? '';
        const info = this.gesture(w, { kind: dir === 'out' ? 'shapeLink' : 'shapeLinkIn', source, cards: this.candidates(w, '.catenary-card', card), boxes: this.candidates(w, '.catenary-note', el => this.arrowEnd(w, el)) });
        this.connectDrag(w, start, {
            selector: '.catenary-card, .catenary-note', source: this.nodeOf(w, source), info,
            problem: (el, i) => el.matches('.catenary-note') ? problemIn(i, 'boxes', this.arrowEnd(w, el)) : problemIn(i, 'cards', card(el)),
            drop: (e, el) => {
                if (el.matches('.catenary-note')) void this.actions.createArrow(view, source, this.idOf(w, el, '.catenary-note')!);
                else if (dir === 'out') void this.actions.linkShape(source, this.idOf(w, el, '.catenary-card')!, view, this.editors.toModel(w, e.clientX, e.clientY));
                else void this.actions.linkShape(this.idOf(w, el, '.catenary-card')!, source, view, this.editors.toModel(w, e.clientX, e.clientY));
            },
            click: (e, i) => canvas(this.beside(w, i.box, button, dir), e),
            empty: e => canvas(this.editors.toModel(w, e.clientX, e.clientY), e),
        });
    }

    /** The end of an arrow to the box `el` of the view, as the backend checks it (ops.createArrow): its element or box id; '' for none. */
    protected arrowEnd(w: GLSPDiagramWidget, el: Element): string {
        return ownerOfLabel(this.idOf(w, el, BOXES) ?? '');
    }

    /**
     * Presses on shape elements: "+ attribute", the ⇥ of a row, the value of a row, a row (click selects; a drag out of the card shows the
     * property as an edge), the × and "+ concept" of a value set. True: handled.
     */
    protected shapesPress(w: GLSPDiagramWidget, target: Element, e: MouseEvent): boolean {
        const view = viewIdOf(w);
        if (!this.editors.diagram(w) || !target.closest) return false;
        const stop = () => { e.preventDefault(); e.stopPropagation(); return true; };
        if (target.closest('.shape-add-row')) {
            const shape = this.idOf(w, target, '.shape-card');
            if (shape) this.addAttribute(w, shape);
            return stop();
        }
        if (target.closest('.row-in')) {
            const property = this.idOf(w, target, '.catenary-edge');
            if (property) void this.actions.putBack(view, property);
            return stop();
        }
        if (target.closest('.latent-out')) {
            const latent = this.idOf(w, target, '.catenary-edge');
            if (latent?.endsWith(LATENT_SUFFIX)) void this.actions.takeOut(view, latent.slice(0, -LATENT_SUFFIX.length));
            return stop();
        }
        const row = this.idOf(w, target, '.shape-row');
        if (row && target.closest('.row-out')) {
            void this.actions.takeOut(view, row);
            return stop();
        }
        // The head of a row group (a logical constraint without a hub placement): only ⇥.
        if (row?.startsWith('c-')) return stop();
        if (row && !target.closest('[data-card]') && e.detail === 1) {
            stop();
            // Delay the value picker until release: both the path and the value can start a drag.
            const range = target.closest('.row-range');
            this.rowDrag(w, row, target.closest('.shape-row')!, e, range ? () => void this.pickValue(w, row, range) : undefined);
            return true;
        }
        // "One of" card of an "or" range: ➟ shows the card of an alternative, × removes the alternative, "+ alternative" picks one more.
        const oneOf = this.idOf(w, target, '.leaf-or');
        if (oneOf && target.closest('.member-take-out, .member-remove, .member-add')) {
            const property = ownerOfLabel(oneOf), key = target.closest('.member-row')?.getAttribute('data-member');
            if (target.closest('.member-add')) {
                const r = target.closest('.member-add')!.getBoundingClientRect();
                void this.actions.addAlternative(property, view, { x: r.left, y: r.bottom + 4 });
            } else if (key && target.closest('.member-remove')) void this.actions.removeAlternative(property, key, view);
            else {
                const card = target.closest('.member-take-out')!.getAttribute('data-instance');
                if (card) void this.actions.showAlternative(view, property, card);
            }
            return stop();
        }
        const set = this.idOf(w, target, '.valueset-card');
        const chip = target.closest('.member-row');
        if (set && chip && target.closest('.member-take-out')) {
            const instance = target.closest('.member-take-out')!.getAttribute('data-instance');
            if (instance) void this.actions.showConcepts(view, set, [instance]);
            return stop();
        }
        if (set && chip && target.closest('.member-remove')) {
            void this.actions.removeConcept(set, chip.getAttribute('data-member')!);
            return stop();
        }
        if (set && chip && e.detail === 1) {
            this.conceptDrag(w, chip, e);
            return stop();
        }
        if (set && target.closest('.member-add')) {
            const r = target.closest('.member-add')!.getBoundingClientRect();
            const kind = this.shown(w, set)?.kind;
            inlineInput({ at: { x: r.left, y: r.top + r.height / 2 }, inside: target.closest('.member-add')!, placeholder: kind === 'scheme' ? 'new concept' : 'new or existing concept',
                options: this.actions.conceptOptions(set),
                onCommit: async (text, how) => {
                    // The row shows at once; the server model confirms it, or a failure removes it (pending-members.ts).
                    const label = text.trim(), card = this.editors.placementOf(w, set);
                    if (label) void w.actionDispatcher.dispatch(PendingMemberAction.create(card, label, true));
                    if (!await this.actions.addConcept(set, text) && label) void w.actionDispatcher.dispatch(PendingMemberAction.create(card, label, false));
                    // Enter: the next one.
                    if (how === 'enter') setTimeout(() => this.reopen(w, set, '.member-add'), 50);
                } });
            return stop();
        }
        return false;
    }

    /** After a change, press the element `selector` of `id` again (the next "+ attribute" or "+ concept"). */
    protected reopen(w: GLSPDiagramWidget, id: string, selector: string): void {
        const el = this.nodeOf(w, id)?.querySelector(selector);
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4, button: 0, detail: 1 }));
    }

    /** "+ attribute": type the path in place. Enter creates it (xsd:string, 0..1) and opens the next one; Tab creates it and picks its value. */
    protected addAttribute(w: GLSPDiagramWidget, shape: string): void {
        const el = this.nodeOf(w, shape)?.querySelector('.shape-add-row');
        if (!el) return;
        const r = el.getBoundingClientRect();
        inlineInput({ at: { x: r.left, y: r.top + r.height / 2 }, inside: el, placeholder: 'property name or prefix:local', options: this.actions.pathOptions(),
            onCommit: async (text, how) => {
                const id = await this.actions.createProperty(shape, viewIdOf(w), { kind: 'datatype', datatype: COMMON_DATATYPES[0] }, text, undefined, { maxCount: 1 });
                if (!id) return;
                setTimeout(() => {
                    if (how === 'enter') this.addAttribute(w, shape);
                    const range = this.nodeOf(w, id)?.querySelector('.row-range');
                    if (how === 'tab' && range) void this.pickValue(w, id, range);
                }, 50);
            } });
    }

    /** The value picker of a row: datatypes, node kinds, value sets, classes. A value set gets its node right of the card. */
    protected async pickValue(w: GLSPDiagramWidget, id: string, el: Element): Promise<void> {
        const { property: p, ownerBox: card } = await this.gesture(w, { kind: 'element', id });
        if (!p) return;
        const r = el.getBoundingClientRect();
        const range = await this.actions.askRange(`Value of ${formatPath(p.path)}`, { x: r.left, y: r.bottom + 4 });
        if (!range) return;
        const view = viewIdOf(w);
        await this.actions.setRange(id, range, view, card ? { x: card.x + card.width + 200, y: card.y + card.height / 2 } : undefined);
    }

    /** Press on a row: a click selects it (Ctrl/Shift: toggle); a drag out of its card shows it as an edge, its pill at the release point. */
    protected rowDrag(w: GLSPDiagramWidget, row: string, el: Element, start: MouseEvent, onClick?: () => void): void {
        const card = el.closest('.shape-card')?.querySelector('.body')?.getBoundingClientRect();
        const outside = (e: MouseEvent) => !!card && (e.clientX < card.left - 8 || e.clientX > card.right + 8 || e.clientY < card.top - 8 || e.clientY > card.bottom + 8);
        const cardOf = (c: Element) => this.idOf(w, c, '.catenary-card') ?? '';
        const info = this.gesture(w, { kind: 'row', row, cards: this.candidates(w, '.catenary-card', cardOf) });
        const drag = (e: MouseEvent) => this.connectDrag(w, e, {
            // Another node shape or value set (its own card: the drag starts there).
            selector: '.catenary-card', source: el, from: { x: start.clientX, y: start.clientY }, info,
            problem: (c, i) => problemIn(i, 'cards', cardOf(c)),
            drop: (up, c) => {
                const view = viewIdOf(w), at = this.editors.toModel(w, up.clientX, up.clientY);
                void this.actions.retarget(row, this.idOf(w, c, '.catenary-card')!, view).then(() => this.actions.takeOut(view, row, at));
            },
            empty: up => void this.actions.takeOut(viewIdOf(w), row, this.editors.toModel(w, up.clientX, up.clientY)),
        });
        this.pressDrag(start, drag, (e, moved) => {
            e.stopPropagation();
            if (moved) return;
            if (onClick && !e.ctrlKey && !e.metaKey && !e.shiftKey) return onClick();
            if (e.ctrlKey || e.metaKey || e.shiftKey) this.toggle(w, row);
            else {
                w.actionDispatcher.dispatch(SelectAction.create({ selectedElementsIDs: [row], deselectedElementsIDs: true }));
                focusCanvas(w);
            }
        }, outside);
    }

    /** "+ member" of an instance collection: an instance by label (Enter: the next one). */
    protected addMember(w: GLSPDiagramWidget, collection: string, add: Element): void {
        const r = add.getBoundingClientRect(), view = viewIdOf(w);
        inlineInput({ at: { x: r.left, y: r.top + r.height / 2 }, inside: add, placeholder: 'instance', options: this.actions.memberOptions(view, collection),
            onCommit: async (text, how) => {
                if (await this.actions.addMember(view, collection, text) && how === 'enter') setTimeout(() => this.reopenCollection(w, collection), 50);
            } });
    }

    protected reopenCollection(w: GLSPDiagramWidget, id: string): void {
        const el = this.nodeOf(w, id)?.querySelector('.member-add');
        if (el) this.addMember(w, id, el);
    }

    /** Drag a concept onto another concept to add skos:broader. A click leaves double-click rename available. */
    protected conceptDrag(w: GLSPDiagramWidget, chip: Element, start: MouseEvent): void {
        const uri = chip.getAttribute('data-member')!;
        const member = (row: Element) => row.getAttribute('data-member') ?? '';
        const info = this.gesture(w, { kind: 'broader', uri, concepts: this.candidates(w, '.valueset-card .member-row', member) });
        this.pressDrag(start, e => this.connectDrag(w, e, {
            selector: '.valueset-card .member-row', source: chip, from: { x: start.clientX, y: start.clientY }, info,
            problem: (row, i) => problemIn(i, 'concepts', member(row)),
            drop: (_e, row) => void this.actions.setConceptBroader(uri, row.getAttribute('data-member')!),
        }), e => e.stopPropagation());
    }

    /**
     * Logic handle of a selected free property edge (not a member of a logical constraint). Release on another free property of the same
     * node shape (edge or row): a new "or" of the two. Release on the ring of a constraint circle of the same node shape: the property
     * joins it. Other elements are dimmed (connectDrag).
     */
    protected logicDrag(w: GLSPDiagramWidget, from: string, start: MouseEvent): void {
        // A free property (edge or row), or the ring of a constraint circle (not its label or lines).
        const id = (el: Element) => this.idOf(w, el, '.catenary-edge.property, .shape-row, .catenary-logic');
        const selector = '.catenary-edge.property, .shape-row, .catenary-logic > .ring';
        const info = this.gesture(w, { kind: 'logic', from, ids: this.candidates(w, selector, el => id(el) ?? '') });
        this.connectDrag(w, start, {
            selector, source: this.nodeOf(w, from), info,
            problem: (el, i) => problemIn(i, 'ids', id(el) ?? ''),
            drop: (_e, el) => void this.actions.group([from, id(el)!], viewIdOf(w)),
        });
    }

    /**
     * "+ target" handle of a selected property edge. Release on a card that is not yet a target (node shape, scheme, collection): it is
     * one more target ("one of"). A click: the target picker at the handle (any target: class, datatype, node kind, …). Other elements are
     * dimmed (connectDrag).
     */
    protected targetDrag(w: GLSPDiagramWidget, property: string, start: MouseEvent): void {
        const card = (el: Element) => this.idOf(w, el, '.catenary-card') ?? '';
        const info = this.gesture(w, { kind: 'target', property, cards: this.candidates(w, '.catenary-card', card) });
        this.connectDrag(w, start, {
            selector: '.catenary-card', source: this.nodeOf(w, property), info,
            problem: (el, i) => problemIn(i, 'cards', card(el)),
            drop: (_e, el, i) => { if (i.property) void this.actions.addTargetCard(property, card(el), viewIdOf(w)); },
            click: (e, i) => { if (i.property) void this.actions.addAlternative(property, viewIdOf(w), { x: e.clientX, y: e.clientY }); },
        });
    }

    /**
     * Link button: dashed line from the button to the pointer. Release on another card: relation; on empty canvas: picker for
     * the target (existing or new instance), placed at the release point; on a note: an arrow to it. A click: the same picker, the target right of the card.
     * `dir` 'in' (incoming button): `source` is the object of the relation, the other instance its subject; on a click, left of the card.
     */
    protected linkDrag(w: GLSPDiagramWidget, source: string, start: MouseEvent, button: Element, dir: 'out' | 'in' = 'out'): void {
        const view = viewIdOf(w);
        const point = (at: Point, e: MouseEvent) => this.actions.connectPoint(dir, source, view, at, { x: e.clientX, y: e.clientY });
        const card = (el: Element) => this.idOf(w, el, '.catenary-card') ?? '';
        const info = this.gesture(w, { kind: dir === 'out' ? 'link' : 'linkIn', source, cards: this.candidates(w, '.catenary-card', card), boxes: this.candidates(w, '.catenary-note', el => this.arrowEnd(w, el)) });
        this.connectDrag(w, start, {
            selector: '.catenary-card, .catenary-note', source: this.nodeOf(w, source), info,
            problem: (el, i) => el.matches('.catenary-note') ? problemIn(i, 'boxes', this.arrowEnd(w, el)) : problemIn(i, 'cards', card(el)),
            drop: (e, el) => {
                if (el.matches('.catenary-note')) void this.actions.createArrow(view, source, this.idOf(w, el, '.catenary-note')!);
                else {
                    const other = this.idOf(w, el, '.catenary-card')!;
                    void (dir === 'out' ? this.actions.connect(source, other, view, { x: e.clientX, y: e.clientY }) : this.actions.connect(other, source, view, { x: e.clientX, y: e.clientY }));
                }
            },
            click: (e, i) => point(this.beside(w, i.box, button, dir), e),
            empty: e => point(this.editors.toModel(w, e.clientX, e.clientY), e),
        });
    }

    /** Arrow button of a note: dashed line from the button to the pointer. Release on another box of the view that has no arrow from the note yet: an arrow to it. */
    protected arrowDrag(w: GLSPDiagramWidget, source: string, start: MouseEvent): void {
        const info = this.gesture(w, { kind: 'arrow', source, boxes: this.candidates(w, BOXES, el => this.arrowEnd(w, el)) });
        this.connectDrag(w, start, {
            selector: BOXES, source: this.nodeOf(w, source), info,
            problem: (el, i) => problemIn(i, 'boxes', this.arrowEnd(w, el)),
            drop: (_e, el) => void this.actions.createArrow(viewIdOf(w), source, ownerOfLabel(this.idOf(w, el, BOXES)!)),
        });
    }
}
