// Client model classes and views. Ported from the browser prototype (claude-attempt/src/ui/diagram/views.tsx).

import {
    GChildElement, GEdge, GLSPProjectionView, GLabel, GLabelView, GModelElement, GNode, GResizeHandle, GResizeHandleView, GViewportRootElement,
    IView, IViewArgs, RenderingContext, ResizeHandleLocation, ShapeView, deletableFeature, fadeFeature, hoverFeedbackFeature, moveFeature,
    popupFeature, resizeFeature, selectFeature, svg
} from '@eclipse-glsp/client';
import { inject, injectable } from '@theia/core/shared/inversify';
import { MarkdownRenderResult } from '@theia/core/lib/browser/markdown-rendering/markdown-renderer';
import { NoteMarkdown } from '../notes/note-markdown';
import { VNode, h } from 'snabbdom';
import { type AlternativeRow, type Side } from '@catenary/model';
import {
    BOX_HALO, COLLECTION_HALO, CollectionMember, MULTI_HALO, NOTE_HALO, ONE_OF_HALO, cardHalo, shapeHalo, colorVars, handlePoint, renderCard, renderCollection, renderHalo, renderPill,
    renderOneOf, renderShapeCard, renderShapeRow, renderValueSet, resizeHandle, s, vars
} from './card-chrome';
import { edgeGeometry, logicCenter, renderEdge, renderLogic } from './edge-chrome';
import { Rect, Route, RouteRequest, routeEdges } from './edge-route';
import { edgeStyle } from './edge-preferences';

export { COLOR_NAMES, COLOR_ORDER, PRESETS, colorValue, colorVars } from './card-chrome';

// No boundsFeature: the size comes from the model only. With it, the hidden DOM measurement would
// return the SVG bounding box (badge, handle, long names) and the size would grow on each move.
export class CardNode extends GNode {
    static override readonly DEFAULT_FEATURES = [
        selectFeature, moveFeature, resizeFeature, deletableFeature, hoverFeedbackFeature, fadeFeature, popupFeature
    ];
    /** Eight handles, as Reactodia: corners and side middles (GLSP default: corners). */
    readonly resizeLocations = ResizeHandleLocation.ALL;
    name = '';
    className = '';
    classColor = '';
    color = '';
    lines: string[] = [];
    violations = 0;
    known = true;
    display = 'detailed';
    /** Related instances that the view does not show (halo buttons). */
    hiddenIn = 0;
    hiddenOut = 0;
    /** Node shapes with sh:targetSubjectsOf that apply to this instance, outside the view. */
    hiddenTargets = 0;
}

export class NoteNode extends GNode {
    static override readonly DEFAULT_FEATURES = [
        selectFeature, moveFeature, resizeFeature, deletableFeature, hoverFeedbackFeature, fadeFeature
    ];
    /** Eight handles, as Reactodia: corners and side middles (GLSP default: corners). */
    readonly resizeLocations = ResizeHandleLocation.ALL;
    text = '';
    color = '';
}

export class ViewReferenceNode extends GNode {
    static override readonly DEFAULT_FEATURES = [
        selectFeature, moveFeature, resizeFeature, deletableFeature, hoverFeedbackFeature, fadeFeature
    ];
    /** Eight handles, as Reactodia: corners and side middles (GLSP default: corners). */
    readonly resizeLocations = ResizeHandleLocation.ALL;
    name = '';
    targetViewId = '';
    /** File reference (ADR 0004): the absolute path; `broken`: not on disk. */
    targetFile = '';
    broken = false;
    color = '';
}

/**
 * A container: a box whose parts are rows (ui-manifest §6.5): a node shape card, an instance collection, a SKOS scheme or collection, the
 * "one of" box of a property. One behavior for all: select, move, resize (eight handles), Del, hover; the halo of the only selected box.
 * The kinds differ in their rows and in the effects of their row buttons (CanvasInteractions.containers).
 */
export abstract class ContainerNode extends GNode {
    static override readonly DEFAULT_FEATURES = [
        selectFeature, moveFeature, resizeFeature, deletableFeature, hoverFeedbackFeature, fadeFeature
    ];
    readonly resizeLocations = ResizeHandleLocation.ALL;
    color = '';
}

export class CollectionNode extends ContainerNode {
    members: CollectionMember[] = [];
}

export class GroupNode extends GNode {
    static override readonly DEFAULT_FEATURES = [
        selectFeature, moveFeature, resizeFeature, deletableFeature, hoverFeedbackFeature, fadeFeature
    ];
    /** Eight handles, as Reactodia: corners and side middles (GLSP default: corners). */
    readonly resizeLocations = ResizeHandleLocation.ALL;
    color = '';
}

export class RelationEdge extends GEdge {
    static override readonly DEFAULT_FEATURES = [selectFeature, deletableFeature, hoverFeedbackFeature, fadeFeature];
    name = '';
    fromSide: Side | '' = '';
    toSide: Side | '' = '';
    color = '';
    hidden = false;
    lane = 0;
    lanes = 1;
}

/** Informative arrow from or to a note. View only. */
export class ArrowEdge extends GEdge {
    static override readonly DEFAULT_FEATURES = [selectFeature, deletableFeature, hoverFeedbackFeature, fadeFeature];
    color = '';
    lane = 0;
    lanes = 1;
}

/** Relations between a collection and another box, with one predicate and direction. Not selectable: expand the collection to edit them. */
export class BundleEdge extends GEdge {
    static override readonly DEFAULT_FEATURES = [fadeFeature];
    name = '';
    count = 1;
    lane = 0;
    lanes = 1;
}

// ------------------------------------------------------------------ shapes views

/** Node shape card: a container whose rows are its property shapes (ShapeRow children). */
export class ShapeNode extends ContainerNode {
    className = '';
    name = '';
    subtitle = '';
    closed = false;
    violations = 0;
    display = 'detailed';
    /** Node shapes with a property to this one that the view does not show (halo button). */
    hiddenSources = 0;
    /** Checked instances outside this view. */
    hiddenTargets = 0;
}

/** A row of the attribute list of a shape card: a property shape. Selectable; its id is the property shape id. */
export class ShapeRow extends GChildElement {
    static readonly DEFAULT_FEATURES = [selectFeature, hoverFeedbackFeature];
    parts: { text: string; color?: string }[] = [];
    range = '';
    style = '';
    card = '';
    violations = 0;
    relation = false;
    selected = false;
    /** 'head' or 'member' of the row group of an unplaced logical constraint (ADR 0014); empty: a property row. */
    group = '';
}

/** SKOS concept scheme or collection: its concepts without a card are rows. */
export class ValueSetNode extends ContainerNode {
    name = '';
    kind: 'scheme' | 'collection' = 'scheme';
    uri = '';
    members: { uri: string; label: string; broader?: string[]; instance: string }[] = [];
}

/** "One of" box of a property (sh:or of ranges): its alternatives without a line are rows. Its id: `<property id>_leaf`. */
export class OneOfNode extends ContainerNode {
    name = '';
    members: AlternativeRow[] = [];
}

/** Property shape drawn as an edge (its id is the property shape id). */
export class PropertyEdge extends GEdge {
    static override readonly DEFAULT_FEATURES = [selectFeature, deletableFeature, hoverFeedbackFeature, fadeFeature];
    name = '';
    parts: { text: string; color?: string }[] = [];
    card = '';
    violations = 0;
    canPutBack = false;
    /** A member of a logical constraint: no logic handle. */
    member = false;
    lane = 0;
    lanes = 1;
}

/**
 * Pill: the end of a property line that is not a card (ADR 0014). A class without a node shape (shared, placed); the "in" box of a
 * property (placed by its list); a private pill of a datatype, node kind or "any" (beside its card, not placed).
 */
export class LeafNode extends GNode {
    static override readonly DEFAULT_FEATURES = [selectFeature, moveFeature, hoverFeedbackFeature, fadeFeature];
    text = '';
    style = '';
}

/** The dashed edge of a property shown as a row (`TYPES.LATENT`). Not selectable: its button shows the property as an edge. */
export class LatentEdge extends GEdge {
    static override readonly DEFAULT_FEATURES = [fadeFeature];
    name = '';
    parts: { text: string; color?: string }[] = [];
    lane = 0;
    lanes = 1;
}

/** Derived source-property → sh:targetSubjectsOf-shape edge. It has no edit controls. */
export class TargetingEdge extends GEdge {
    static override readonly DEFAULT_FEATURES = [fadeFeature];
    name = '';
    lane = 0;
    lanes = 1;
}

/** From a "one of" box to the card of an alternative. Not selectable: edit the alternatives on the box. */
export class AlternativeEdge extends GEdge {
    static override readonly DEFAULT_FEATURES = [fadeFeature];
    lane = 0;
    lanes = 1;
}

/** Logical constraint (sh:or, sh:xone, sh:and, sh:not): drawn from the geometry of its member edges. */
export class LogicNode extends GNode {
    static override readonly DEFAULT_FEATURES = [selectFeature, deletableFeature, hoverFeedbackFeature];
    operator = '';
    members: string[] = [];
}

@injectable()
export class ShapeCardView extends ShapeView {
    render(node: Readonly<ShapeNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) return undefined;
        const rows = node.children.filter(c => c instanceof ShapeRow).map(c => context.renderElement(c)).filter((v): v is VNode => !!v);
        return renderShapeCard({
            width: node.size.width, height: node.size.height, className: node.className, name: node.name, subtitle: node.subtitle, color: node.color,
            selected: node.selected, hover: node.hoverFeedback, violations: node.violations, closed: node.closed, display: node.display
        }, rows, renderChildren(node, context, true));
    }
}

@injectable()
export class ShapeRowView implements IView {
    render(row: Readonly<ShapeRow>, _context: RenderingContext): VNode {
        return renderShapeRow({ id: row.id, parts: row.parts, range: row.range, style: row.style, card: row.card, violations: row.violations, selected: row.selected, relation: row.relation, group: row.group });
    }
}

/** The box props of a member-list container. */
const memberBox = (node: Readonly<ContainerNode>) => ({ width: node.size.width, height: node.size.height, color: node.color, selected: node.selected, hover: node.hoverFeedback });

@injectable()
export class ValueSetView extends ShapeView {
    render(node: Readonly<ValueSetNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) return undefined;
        return renderValueSet({ ...memberBox(node), name: node.name, kind: node.kind, uri: node.uri, members: node.members }, renderChildren(node, context, true));
    }
}

@injectable()
export class OneOfView extends ShapeView {
    render(node: Readonly<OneOfNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) return undefined;
        return renderOneOf({ ...memberBox(node), name: node.name, members: node.members }, renderChildren(node, context, true));
    }
}

/**
 * Routes of all edges of the diagram (edge-route.ts), computed once for each state of the boxes and edges: the key has the style, the
 * bounds of the boxes and the ends of the edges, so a move or resize (bounds change in place, same root) routes again. Groups and logical
 * constraint circles are not obstacles. undefined: style "direct", or no route for this edge (the view draws the curve).
 */
const routeCache = new WeakMap<object, { key: string; routes: Map<string, Route> }>();
function routeOf(edge: Readonly<GEdge>): Route | undefined {
    const style = edgeStyle();
    if (style === 'direct') return undefined;
    const root = edge.root;
    const boxes = new Map<string, Rect>();
    const edges: RouteRequest[] = [];
    const parts: string[] = [style];
    for (const c of root.children) {
        if (c instanceof GNode && !(c instanceof GroupNode) && !(c instanceof LogicNode)) {
            const b = c.bounds;
            boxes.set(c.id, b);
            parts.push(`${c.id} ${b.x} ${b.y} ${b.width} ${b.height}`);
        } else if (c instanceof GEdge && !(c instanceof LatentEdge)) {
            const e = c as GEdge & { fromSide?: Side | ''; toSide?: Side | ''; lane?: number; lanes?: number };
            const request = { id: e.id, source: e.sourceId, target: e.targetId, fromSide: e.fromSide ?? '', toSide: e.toSide ?? '', lane: e.lane ?? 0, lanes: e.lanes ?? 1 };
            edges.push(request);
            parts.push(`${request.id} ${request.source} ${request.target} ${request.fromSide} ${request.toSide} ${request.lane} ${request.lanes}`);
        }
    }
    const key = parts.join('\n');
    let cached = routeCache.get(root);
    if (cached?.key !== key) {
        cached = { key, routes: routeEdges(boxes, edges, style) };
        routeCache.set(root, cached);
    }
    return cached.routes.get(edge.id);
}

@injectable()
export class PropertyEdgeView implements IView {
    render(edge: Readonly<PropertyEdge>, _context: RenderingContext): VNode {
        const source = edge.source as GNode | undefined;
        const target = edge.target as GNode | undefined;
        if (!source || !target) return svg('g', null);
        return renderEdge({
            source: source.bounds, target: target.bounds, fromSide: '', toSide: '', lane: edge.lane, lanes: edge.lanes, self: source === target, elbow: true,
            route: routeOf(edge), style: edgeStyle(),
            zoom: zoomOf(edge), name: edge.name, parts: edge.parts, card: edge.card, invalid: edge.violations > 0, logicHandle: !edge.member, targetHandle: true, canPutBack: edge.canPutBack,
            color: '', selected: edge.selected, hover: edge.hoverFeedback, hidden: false
        });
    }
}

/** Drawn while its owner card or its target is selected (spec/ui-manifest.hs §6.1): a direct curve, not routed. */
@injectable()
export class LatentEdgeView implements IView {
    render(edge: Readonly<LatentEdge>, _context: RenderingContext): VNode {
        const source = edge.source as GNode | undefined;
        const target = edge.target as GNode | undefined;
        const selected = (n: GNode) => 'selected' in n && !!n.selected;
        if (!source || !target || !(selected(source) || selected(target))) return svg('g', null);
        return renderEdge({
            source: source.bounds, target: target.bounds, fromSide: '', toSide: '', lane: edge.lane, lanes: edge.lanes, self: source === target, elbow: true,
            zoom: zoomOf(edge), name: edge.name, parts: edge.parts, color: '', selected: false, hover: false, hidden: false, latent: true
        });
    }
}

/** Derived target-subject edge: always visible when both shape cards show. */
@injectable()
export class TargetingEdgeView implements IView {
    render(edge: Readonly<TargetingEdge>, _context: RenderingContext): VNode {
        const source = edge.source as GNode | undefined;
        const target = edge.target as GNode | undefined;
        if (!source || !target) return svg('g', null);
        return renderEdge({
            source: source.bounds, target: target.bounds, fromSide: '', toSide: '', lane: edge.lane, lanes: edge.lanes, self: source === target, elbow: true,
            route: routeOf(edge), style: edgeStyle(), zoom: zoomOf(edge), name: edge.name, color: '', selected: false, hover: false, hidden: false, targeting: true
        });
    }
}

@injectable()
export class LeafView extends ShapeView {
    render(node: Readonly<LeafNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) return undefined;
        const v = renderPill({ width: node.size.width, height: node.size.height, text: node.text, style: node.style });
        v.data!.class = { ...v.data!.class, selected: node.selected };
        return v;
    }
}

/** Label points of the member edges of a logical constraint. */
function logicMids(node: Readonly<LogicNode>): { x: number; y: number }[] {
    return node.members.map(id => node.root.index.getById(id)).filter((e): e is PropertyEdge => e instanceof PropertyEdge).flatMap(e => {
        const source = e.source as GNode | undefined, target = e.target as GNode | undefined;
        if (!source || !target) return [];
        return [edgeGeometry({
            source: source.bounds, target: target.bounds, fromSide: '', toSide: '', lane: e.lane, lanes: e.lanes, zoom: zoomOf(e), self: source === target, elbow: true,
            name: e.name, route: routeOf(e), style: edgeStyle()
        }).label];
    });
}

@injectable()
export class LogicView implements IView {
    render(node: Readonly<LogicNode>, _context: RenderingContext): VNode {
        // The circles before this one (graph order) are placed first; this one keeps clear of them.
        const taken: { x: number; y: number }[] = [];
        for (const other of node.root.children) {
            if (other === node) break;
            if (!(other instanceof LogicNode)) continue;
            const c = logicCenter(logicMids(other), zoomOf(other), taken);
            if (c) taken.push(c);
        }
        const mids = logicMids(node);
        return renderLogic({ mids, center: logicCenter(mids, zoomOf(node), taken), operator: node.operator, zoom: zoomOf(node), selected: node.selected, hover: node.hoverFeedback });
    }
}

/** Card: see card-chrome.ts. */
@injectable()
export class CardView extends ShapeView {
    render(node: Readonly<CardNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) return undefined;
        return renderCard({
            width: node.size.width, height: node.size.height, zoom: zoomOf(node), className: node.className, name: node.name, lines: node.lines,
            color: node.color, classColor: node.classColor, selected: node.selected, hover: node.hoverFeedback,
            violations: node.violations, known: node.known, display: node.display
        }, renderChildren(node, context, true));
    }
}

const isBox = (e: GModelElement) => e instanceof CardNode || e instanceof GroupNode || e instanceof NoteNode || e instanceof ViewReferenceNode
    || e instanceof ContainerNode;

/**
 * Diagram: as GLSP, then the halo of the only selected box (card, group, note, view reference, collection) or of several, after all
 * elements, so that no element covers it (Reactodia draws it on a layer above the elements). CanvasInteractions handles its buttons
 * (`data-element`: the only selected box, '' for several).
 */
@injectable()
export class CatenaryGraphView extends GLSPProjectionView {
    /** No projection bars (GLSP scroll bars at the right and bottom edges): they draw lines over the canvas and the palette. */
    protected override renderProjections(): VNode[] {
        return [];
    }

    override renderSvg(model: Readonly<GViewportRootElement>, context: RenderingContext, args?: IViewArgs): VNode {
        const vnode = super.renderSvg(model, context, args);
        const layer = vnode.children?.[0];
        if (context.targetKind === 'hidden' || !layer || typeof layer === 'string') return vnode;
        // Selected edges last: their controls (⇥, cardinality, logic handle) are above the hit paths of the other edges.
        const selectedEdges = new Set([...model.index.all()].filter(e => e instanceof GEdge && (e as { selected?: boolean }).selected).map(e => e.id));
        if (selectedEdges.size && layer.children) {
            const last = (c: VNode | string) => typeof c !== 'string' && selectedEdges.has(String(c.key));
            layer.children = [...layer.children.filter(c => !last(c)), ...layer.children.filter(last)];
        }
        const boxes = [...model.index.all()].filter((e): e is GNode => (e as { selected?: boolean }).selected === true && isBox(e));
        const k = 1 / zoomOf(model);
        if (boxes.length === 1) {
            const node = boxes[0];
            const { x, y } = node.position, { width, height } = node.size;
            const actions = node instanceof CardNode ? cardHalo(node.hiddenIn, node.hiddenOut, node.hiddenTargets) : node instanceof CollectionNode ? COLLECTION_HALO
                : node instanceof ShapeNode ? shapeHalo(node.hiddenSources, node.hiddenTargets) : node instanceof NoteNode ? NOTE_HALO
                : node instanceof OneOfNode ? ONE_OF_HALO : BOX_HALO;
            layer.children = [...(layer.children ?? []), svg('g', { 'class-catenary-halo': true, 'data-element': node.id, transform: `translate(${x},${y})` },
                ...renderHalo(width, height, k, actions))];
        } else if (boxes.length > 1) {
            // Several: a dashed frame around their common box, and the halo on it.
            const x = Math.min(...boxes.map(b => b.position.x)) - 8 * k, y = Math.min(...boxes.map(b => b.position.y)) - 8 * k;
            const width = Math.max(...boxes.map(b => b.position.x + b.size.width)) + 8 * k - x;
            const height = Math.max(...boxes.map(b => b.position.y + b.size.height)) + 8 * k - y;
            layer.children = [...(layer.children ?? []), svg('g', { 'class-catenary-halo': true, 'data-element': '', transform: `translate(${x},${y})` },
                s('rect', { class: { 'multi-frame': true }, attrs: { width, height, rx: 6 * k, 'stroke-width': 1.5 * k, 'stroke-dasharray': `${6 * k} ${4 * k}` } }),
                ...renderHalo(width, height, k, MULTI_HALO))];
        }
        return vnode;
    }
}

/** Children of a node: the resize handles only, or all other children. */
function renderChildren(node: Readonly<GNode>, context: RenderingContext, handles: boolean): VNode[] {
    return node.children.filter(c => (c.type === GResizeHandle.TYPE) === handles)
        .map(c => context.renderElement(c)).filter((v): v is VNode => !!v);
}

/** Zoom of the diagram of an element, for handles with a constant size on screen. */
function zoomOf(el: Readonly<GModelElement>): number {
    const zoom = (el.root as unknown as { zoom?: number }).zoom;
    return zoom && zoom > 0 ? zoom : 1;
}

/** Resize handle: see resizeHandle in card-chrome.ts. The size on screen is the same at every zoom (GLSP draws 5 model units). */
@injectable()
export class ResizeHandleView extends GResizeHandleView {
    override render(handle: Readonly<GResizeHandle>, context: RenderingContext): VNode | undefined {
        if (context.targetKind === 'hidden') return undefined;
        const { width, height } = (handle.parent as GNode).size;
        return resizeHandle(handle.location, handlePoint(width, height, handle.location), 1 / zoomOf(handle),
            { class: { 'sprotty-resize-handle': true, mouseover: handle.hoverFeedback } });
    }
}

/** Floating text note stored only in its view graph. */
@injectable()
export class NoteView extends ShapeView {
    @inject(NoteMarkdown) protected readonly markdown: NoteMarkdown;
    protected readonly rendered = new WeakMap<Element, { text: string; result: MarkdownRenderResult }>();

    render(node: Readonly<NoteNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) return undefined;
        const { width, height } = node.size;
        const mount = (vnode: VNode) => {
            const host = vnode.elm as Element;
            const old = this.rendered.get(host);
            if (old?.text === node.text) return;
            old?.result.dispose();
            const result = this.markdown.render(node.text);
            host.replaceChildren(result.element);
            this.rendered.set(host, { text: node.text, result });
        };
        const content = h('div', {
            class: { 'note-body': true },
            hook: {
                insert: mount,
                update: (_old, next) => mount(next),
                destroy: vnode => {
                    const host = vnode.elm as Element;
                    this.rendered.get(host)?.result.dispose();
                    this.rendered.delete(host);
                }
            }
        });
        return svg('g', {
            'class-catenary-note': true, 'class-selected': node.selected, 'class-mouseover': node.hoverFeedback,
            style: vars(colorVars(node.color))
        },
            svg('rect', { 'class-body': true, width, height, rx: 8 }),
            svg('foreignObject', { 'class-note-fo': true, width, height }, content),
            ...renderChildren(node, context, false),
            ...renderChildren(node, context, true)
        );
    }
}

/** Positioned link to another view or to a file. CanvasInteractions opens its target on a plain click. */
@injectable()
export class ViewReferenceView extends ShapeView {
    render(node: Readonly<ViewReferenceNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) return undefined;
        const { width, height } = node.size;
        const file = !!node.targetFile;
        const content = h('div', { class: { 'view-reference-body': true } }, [
            h('span', { class: { codicon: true, 'codicon-type-hierarchy': !file, 'codicon-file': file && !node.broken, 'codicon-warning': node.broken } }),
            h('span', { class: { label: true }, attrs: { title: file ? `${node.targetFile}${node.broken ? '\nNot on disk (moved or removed)' : ''}` : '' } }, node.name)
        ]);
        return svg('g', {
            'class-catenary-view-reference': true, 'class-file-reference': file, 'class-broken': node.broken, 'class-colored': !!node.color,
            'class-selected': node.selected, 'class-mouseover': node.hoverFeedback,
            'data-target': node.targetViewId, 'data-file': node.targetFile, style: vars(colorVars(node.color))
        },
            svg('rect', { 'class-body': true, width, height, rx: 10 }),
            svg('foreignObject', { 'class-view-reference-fo': true, width, height }, content),
            ...context.renderChildren(node)
        );
    }
}

/** Collection: see renderCollection in card-chrome.ts. */
@injectable()
export class CollectionView extends ShapeView {
    render(node: Readonly<CollectionNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) return undefined;
        return renderCollection({ ...memberBox(node), members: node.members }, renderChildren(node, context, true));
    }
}

/** Group: tinted rectangle with its name above the top-left corner (as JSON Canvas groups). */
@injectable()
export class GroupView extends ShapeView {
    render(node: Readonly<GroupNode>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(node, context)) return undefined;
        const { width, height } = node.size;
        return svg('g', {
            'class-catenary-group': true, 'class-colored': !!node.color, 'class-selected': node.selected, 'class-mouseover': node.hoverFeedback,
            style: vars(colorVars(node.color))
        },
            svg('rect', { 'class-body': true, width, height, rx: 16 }),
            ...context.renderChildren(node)
        );
    }
}

/** Name label of a group: SVG text above the group. Cards have no label child: they draw the name as HTML (card-chrome.ts). */
@injectable()
export class NameLabelView extends GLabelView {
    override render(label: Readonly<GLabel>, context: RenderingContext): VNode | undefined {
        if (!this.isVisible(label, context)) return undefined;
        return svg('g', { 'class-catenary-name': true, 'class-group-label': true },
            svg('text', { x: 0, y: 0 }, label.text));
    }
}

/** Bundle: an edge whose label has the number of relations. */
@injectable()
export class BundleEdgeView implements IView {
    render(edge: Readonly<BundleEdge>, _context: RenderingContext): VNode {
        const source = edge.source as GNode | undefined;
        const target = edge.target as GNode | undefined;
        if (!source || !target) return svg('g', null);
        const vnode = renderEdge({
            source: source.bounds, target: target.bounds, fromSide: '', toSide: '', lane: edge.lane, lanes: edge.lanes, zoom: zoomOf(edge),
            route: routeOf(edge), style: edgeStyle(),
            name: edge.count > 1 ? `${edge.name} ×${edge.count}` : edge.name, color: '', selected: false, hover: false, hidden: false
        });
        vnode.data!.class = { ...vnode.data!.class, 'catenary-bundle': true };
        return vnode;
    }
}

/** Edge: see edge-chrome.ts. */
@injectable()
export class RelationEdgeView implements IView {
    render(edge: Readonly<RelationEdge>, _context: RenderingContext): VNode {
        const source = edge.source as GNode | undefined;
        const target = edge.target as GNode | undefined;
        if (!source || !target) return svg('g', null);
        return renderEdge({
            source: source.bounds, target: target.bounds, fromSide: edge.fromSide, toSide: edge.toSide, lane: edge.lane, lanes: edge.lanes,
            route: routeOf(edge), style: edgeStyle(),
            zoom: zoomOf(edge), name: edge.name, color: edge.color, selected: edge.selected, hover: edge.hoverFeedback, hidden: edge.hidden
        });
    }
}

/** From a "one of" card to an alternative: a plain edge without label. */
@injectable()
export class AlternativeEdgeView implements IView {
    render(edge: Readonly<AlternativeEdge>, _context: RenderingContext): VNode {
        const source = edge.source as GNode | undefined;
        const target = edge.target as GNode | undefined;
        if (!source || !target) return svg('g', null);
        const vnode = renderEdge({
            source: source.bounds, target: target.bounds, fromSide: '', toSide: '', lane: edge.lane, lanes: edge.lanes, zoom: zoomOf(edge),
            route: routeOf(edge), style: edgeStyle(),
            name: '', color: '', selected: false, hover: false, hidden: false
        });
        vnode.data!.class = { ...vnode.data!.class, 'catenary-alternative': true };
        return vnode;
    }
}

/** Arrow: a dashed edge without label or end handles. */
@injectable()
export class ArrowEdgeView implements IView {
    render(edge: Readonly<ArrowEdge>, _context: RenderingContext): VNode {
        const source = edge.source as GNode | undefined;
        const target = edge.target as GNode | undefined;
        if (!source || !target) return svg('g', null);
        return renderEdge({
            source: source.bounds, target: target.bounds, fromSide: '', toSide: '', lane: edge.lane, lanes: edge.lanes, zoom: zoomOf(edge),
            route: routeOf(edge), style: edgeStyle(),
            name: '', color: edge.color, selected: edge.selected, hover: edge.hoverFeedback, hidden: false, arrow: true
        });
    }
}
