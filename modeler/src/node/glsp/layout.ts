// Layout of one view, on request (no automatic layout). Group sizes do not change. Algorithms: see LAYOUT_ALGORITHMS.
// A card, note, view reference, collection or group belongs to the smallest group that contains its box (`inside`, the membership rule of setBounds and
// copy). Each container (the view, or a group) is laid out on its own: a group is a fixed block for its container, and
// an edge to a card inside a group counts as an edge to that block. The cards inside a group get the result only if
// it fits in the group; else they keep their places. Layered (ELK) chooses the order with fewer edge crossings; Force (cola.js) is
// force-directed. The content keeps its top-left corner. Edge sides are cleared:
// each end faces the other card.
//
// Sizes: the layout uses the drawn geometry (toSchema, the same function as the GLSP model), not the stored box. A drawn card can be taller
// than its stored box (rows, members, card text scale), and private pills (ADR 0014) are drawn next to their card. The layout box of a
// card covers the card and these pills. Links: the drawn edges (property lines, relations, alternatives). A hub is drawn on its member
// lines, so its members link the cards.
// Each connected component of a container is laid out on its own. The components are then packed with ELK rectpacking near an aspect ratio:
// ELK layered packs components in rows that come out much taller than its aspect ratio (10 unlinked cards: one column of 5 rows).
// If an ELK algorithm fails, the layout falls back to ELK box (as @rdf-viz/layout, see FALLBACK).

import { Action, ActionHandler, FitToScreenAction } from '@eclipse-glsp/server';
import { inject, injectable } from '@theia/core/shared/inversify';
import ELK, { ElkNode } from 'elkjs/lib/elk.bundled.js';
import * as cola from 'webcola';
import { Box, Doc, ElementSchema, GraphOptions, LEAF_SUFFIX, Rect, TYPES, ViewFigures, collectionOf, groupOf, boxes, toSchema } from '@catenary/model';
import { LAYOUT_SPACING, LayoutAlgorithm, layoutSpacing } from '../../common/protocol';
import { ViewSession } from './view-session';

const elk = new ELK();

/** ELK layered, for one connected component. */
const options = (direction: 'RIGHT' | 'DOWN', gap: number) => ({
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.spacing.nodeNode': String(gap),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(gap * 2),
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    // ELK chooses the order (layer sweep crossing minimization). Orthogonal routing only for the spacing that it reserves between layers:
    // the routes are not used.
    'elk.separateConnectedComponents': 'false',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.edgeNodeBetweenLayers': String(gap),
    'elk.layered.thoroughness': '30',
    'elk.padding': '[top=0,left=0,bottom=0,right=0]'
});
/** Packing of the components of a container: the rectpacking options of @rdf-viz/layout comboChildOptions (packages/lib/layout/src/presets.js). */
const packing = (gap: number, aspectRatio: number) => ({
    'elk.algorithm': 'rectpacking',
    'elk.aspectRatio': String(aspectRatio),
    'elk.spacing.nodeNode': String(gap),
    'elk.padding': '[top=0,left=0,bottom=0,right=0]'
});
/**
 * Last resort if an ELK algorithm fails: box packing ignores edges and does not recurse (boxFallbackPreset of @rdf-viz/layout,
 * packages/lib/layout/src/presets.js: elkjs can overflow its stack on long chains).
 */
const FALLBACK = (gap: number) => ({ 'elk.algorithm': 'box', 'elk.spacing.nodeNode': String(gap), 'elk.padding': '[top=0,left=0,bottom=0,right=0]' });
/** Aspect ratio (width / height) of the packed components of the view. In a group: the aspect ratio of its free area. */
const ASPECT = 1.6;
/** Free space inside a group: room for the group name at the top. */
const PAD = { top: 48, left: 24, bottom: 24, right: 24 };
/** Gaps between the boxes in a group, largest first: factors of the spacing. */
const GROUP_GAPS = [1.5, 1, 0.5];

/**
 * `box`: the stored box (the result keeps its size). `ext`: the box that the layout places: the drawn card and its pills, absolute.
 * For a group, ext = box.
 */
type Item = { id: string; element?: string; box: Box; ext: Box; group: boolean };

type Layout = { bounds: ({ id: string } & Rect)[]; edges: string[] };
/** `positions`: top-left corners of the ext boxes, relative to the top-left corner of the result. */
type Placed = { positions: Map<string, { x: number; y: number }>; width: number; height: number };

const union = (a: Box, b: Box): Box => {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};
const distance = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x - b.x - b.width, b.x - a.x - a.width), Math.max(0, a.y - b.y - b.height, b.y - a.y - a.height));

/**
 * The drawn geometry of the boxes of the view (toSchema). An item gets the drawn size of its element. A drawn node without a placement
 * (a private pill) goes with the card at the source of an edge to it, else with the nearest box. Returns the items that the view does not
 * draw (the placement of a property line).
 */
function drawnExtents(children: ElementSchema[], items: Item[]): Set<Item> {
    const rect = (c: ElementSchema): Box => ({ ...(c.position as { x: number; y: number }), ...(c.size as { width: number; height: number }) });
    const nodes = new Map(children.filter(c => c.type.startsWith('node:') && c.type !== TYPES.GROUP && c.type !== TYPES.LOGIC && c.position && c.size)
        .map(c => [c.id, c]));
    const owner = new Map<string, Item>();
    const undrawn = new Set<Item>();
    for (const item of items) {
        if (item.group) continue;
        const drawn = nodes.get(item.id);
        if (!drawn) { undrawn.add(item); continue; }
        owner.set(drawn.id, item);
        item.ext = union(item.box, rect(drawn));
    }
    const edges = children.filter(c => c.type.startsWith('edge:'));
    const content = items.filter(i => !i.group);
    for (const [id, c] of nodes) {
        if (owner.has(id)) continue;
        const r = rect(c);
        const from = edges.find(e => e.targetId === id && owner.has(e.sourceId as string));
        const item = from ? owner.get(from.sourceId as string)!
            : content.reduce<Item | undefined>((best, i) => !best || distance(i.box, r) < distance(best.box, r) ? i : best, undefined);
        if (!item) continue;
        owner.set(id, item);
        item.ext = union(item.ext, r);
    }
    return undrawn;
}

/**
 * cola.removeOverlaps, then the overlaps that it leaves: its y pass checks only the next rectangle on the scan line (webcola 3.4
 * findYNeighbours), so two rectangles can stay on top of each other. For these, the rectangles are placed top to bottom; each one
 * moves right or down (the shorter way) until it is clear of the placed ones. Moves go only right or down, so this ends.
 * An overlap less than `EPS` is not an overlap: cola leaves rectangles that touch with 1e-6 overlap, and a move of 1e-14 does not
 * change the coordinates (the loop did not end).
 */
function removeOverlaps(rects: cola.Rectangle[]): void {
    cola.removeOverlaps(rects);
    const EPS = 0.5;
    const hits = (p: cola.Rectangle, r: cola.Rectangle) => p.x < r.X - EPS && r.x < p.X - EPS && p.y < r.Y - EPS && r.y < p.Y - EPS;
    const placed: cola.Rectangle[] = [];
    for (const r of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
        for (let hit = placed.find(p => hits(p, r)); hit; hit = placed.find(p => hits(p, r))) {
            const dx = hit.X - r.x, dy = hit.Y - r.y;
            if (dx < dy) r.setXCentre(r.cx() + dx); else r.setYCentre(r.cy() + dy);
        }
        placed.push(r);
    }
}

/** Placed ext boxes from their top-left corners, moved so that the result starts at (0, 0). */
function placed(children: Item[], corners: { x: number; y: number }[]): Placed {
    const left = Math.min(...corners.map(p => p.x)), top = Math.min(...corners.map(p => p.y));
    const positions = new Map(children.map((c, i) => [c.id, { x: corners[i].x - left, y: corners[i].y - top }]));
    return {
        positions,
        width: Math.max(...children.map(c => positions.get(c.id)!.x + c.ext.width)),
        height: Math.max(...children.map(c => positions.get(c.id)!.y + c.ext.height))
    };
}

/**
 * Force: the cola.js layout of Reactodia (diagram/layoutShared.ts, blockingDefaultLayout): force-directed without overlap avoidance, then
 * overlaps removed, with at least `gap` between boxes.
 */
function colaPlace(children: Item[], links: [string, string][], gap: number): Placed {
    // cola works with box centers.
    const nodes: cola.Node[] = children.map(c => ({ x: c.ext.x + c.ext.width / 2, y: c.ext.y + c.ext.height / 2, width: c.ext.width, height: c.ext.height }));
    const index = new Map(children.map((c, i) => [c.id, i]));
    const edges = links.map(([s, t]) => ({ source: index.get(s)!, target: index.get(t)! }));
    new cola.Layout().nodes(nodes).links(edges).avoidOverlaps(false).convergenceThreshold(1e-9)
        .jaccardLinkLengths(200 + gap).handleDisconnected(true).start(30, 0, 10, undefined, false);
    const half = gap / 2;
    const rects = nodes.map(n => new cola.Rectangle(n.x - n.width! / 2 - half, n.x + n.width! / 2 + half, n.y - n.height! / 2 - half, n.y + n.height! / 2 + half));
    removeOverlaps(rects);
    return placed(children, rects.map((r, i) => ({ x: r.cx() - nodes[i].width! / 2, y: r.cy() - nodes[i].height! / 2 })));
}

/** One ELK run; on failure, ELK box with the same children and no edges. */
async function elkPlace(children: Item[], edges: { id: string; sources: string[]; targets: string[] }[], layoutOptions: Record<string, string>, gap: number): Promise<Placed> {
    const nodes = children.map(c => ({ id: c.id, x: c.ext.x, y: c.ext.y, width: c.ext.width, height: c.ext.height }));
    let result: ElkNode;
    try {
        result = await elk.layout({ id: '__root', layoutOptions, children: nodes, edges });
    } catch (error) {
        console.warn(`ELK ${layoutOptions['elk.algorithm']} layout failed, box layout used:`, error);
        result = await elk.layout({ id: '__root', layoutOptions: FALLBACK(gap), children: nodes, edges: [] });
    }
    const at = new Map((result.children ?? []).map(c => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
    return placed(children, children.map(c => at.get(c.id) ?? { x: 0, y: 0 }));
}

/** Connected components of `ids` (undirected links), in the order of their first member; members keep the order of `ids`. */
export function components(ids: string[], links: [string, string][]): string[][] {
    const root = new Map(ids.map(id => [id, id]));
    const find = (id: string): string => { let r = id; while (root.get(r) !== r) r = root.get(r)!; root.set(id, r); return r; };
    for (const [a, b] of links) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) root.set(ra > rb ? ra : rb, ra > rb ? rb : ra);
    }
    const groups = new Map<string, string[]>();
    for (const id of ids) {
        const r = find(id);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r)!.push(id);
    }
    return [...groups.values()];
}

/** New boxes for the cards and groups of the view, and the edges whose sides are cleared. */
/** `spacing`: px between boxes (Layered: twice that between layers; in a group: the largest of 1.5, 1, 0.5 × spacing or 40 px that fits). */
/** `cardScale`: the card text scale of the client; drawn cards with rows grow with it. */
export async function layoutView(part: Doc, viewId: string, showHidden: boolean, algorithm: LayoutAlgorithm = 'layered',
    spacing: number = LAYOUT_SPACING.default, cardScale = 1, notation?: ViewFigures, applicability?: GraphOptions['applicability']): Promise<Layout> {
    const view = part.views[viewId];
    if (!view) return { bounds: [], edges: [] };
    // Classes only give labels; sizes do not use them.
    const children = (toSchema(part, { classes: [] }, viewId, { showHidden, cardScale, violations: [], notation, applicability }).children ?? []) as ElementSchema[];
    // A member of a collection is not placed: the collection is (the drawn edges go to it). Else the card of the element (its placement
    // id). An "in" or "one of" box (`<property element>_leaf`, placed by its list term): setBounds places that list.
    const item = (b: Box & { id: string }, group = false, element?: string): Item => ({ id: b.id, element, box: b, ext: { x: b.x, y: b.y, width: b.width, height: b.height }, group });
    const listBoxes = children.filter(c => c.type === TYPES.LEAF && c.id.endsWith(LEAF_SUFFIX) && !c.private)
        .map(c => item({ id: c.id, ...(c.position as { x: number; y: number }), ...(c.size as { width: number; height: number }) }));
    const all: Item[] = [
        ...boxes(view, 'card').filter(n => !collectionOf(view, n.element)).map(n => item(n, false, n.element)),
        ...listBoxes,
        ...boxes(view, 'collection').map(c => item(c)),
        ...boxes(view, 'note').map(n => item(n)),
        ...boxes(view, 'reference').map(r => item(r)),
        ...boxes(view, 'group').map(g => item(g, true))
    ];
    const undrawn = drawnExtents(children, all);
    const items = all.filter(i => !undrawn.has(i));
    const ids = new Set(items.map(i => i.id));
    // Links between boxes: the drawn property lines, relations and alternatives. An edge to a private pill links no box.
    const relations = children.filter(c => (c.type === TYPES.PROPERTY || c.type === TYPES.RELATION || c.type === TYPES.ALTERNATIVE || c.type === TYPES.BUNDLE || c.type === TYPES.TARGETING)
        && ids.has(c.sourceId as string) && ids.has(c.targetId as string) && c.sourceId !== c.targetId)
        .map(c => ({ id: c.type === TYPES.RELATION ? String(c.element ?? c.id) : c.id, subject: c.sourceId as string, object: c.targetId as string, derived: c.type === TYPES.TARGETING }));
    if (items.length === 0) return { bounds: [], edges: [] };
    // Parent: the smallest group that contains the box (groupOf).
    const parent = new Map<string, string | undefined>(items.map(x => [x.id, groupOf(view, x.box, x.id)?.id]));
    const childrenOf = (id: string | undefined) => items.filter(x => parent.get(x.id) === id);

    /** The direct child of `container` that holds `id` (the item itself, or the group it is in). */
    const blockIn = (container: string | undefined, id: string): string | undefined => {
        for (let x: string | undefined = id; x !== undefined; x = parent.get(x)) if (parent.get(x) === container) return x;
        return undefined;
    };

    /** Positions of the box corners of the children of a container, relative to the top-left corner of the result. `direction`: layered only. */
    const place = async (container: string | undefined, direction: 'RIGHT' | 'DOWN', gap: number, aspect: number): Promise<Placed> => {
        const children = childrenOf(container);
        const edges = new Map<string, { id: string; sources: string[]; targets: string[] }>();
        for (const r of relations) {
            const s = blockIn(container, r.subject), o = blockIn(container, r.object);
            if (s && o && s !== o && !edges.has(`${s} ${o}`)) edges.set(`${s} ${o}`, { id: `e${edges.size}`, sources: [s], targets: [o] });
        }
        const links = [...edges.values()].map(e => [e.sources[0], e.targets[0]] as [string, string]);
        const parts: Placed[] = [];
        const groups = components(children.map(c => c.id), links).map(ids => children.filter(c => ids.includes(c.id)));
        for (const members of groups) {
            const ids = new Set(members.map(c => c.id));
            const own = [...edges.values()].filter(e => ids.has(e.sources[0]));
            if (members.length === 1) parts.push({ positions: new Map([[members[0].id, { x: 0, y: 0 }]]), width: members[0].ext.width, height: members[0].ext.height });
            else if (algorithm === 'force') parts.push(colaPlace(members, own.map(e => [e.sources[0], e.targets[0]]), gap));
            else parts.push(await elkPlace(members, own, options(direction, gap), gap));
        }
        // Pack the components: each one is a box of its size.
        let corners = [{ x: 0, y: 0 }];
        if (parts.length > 1) {
            const blocks: Item[] = parts.map((p, i) => {
                const b = { id: `__c${i}`, x: 0, y: 0, width: p.width, height: p.height };
                return { id: b.id, box: b, ext: b, group: false };
            });
            const packed = await elkPlace(blocks, [], packing(gap, aspect), gap);
            corners = blocks.map(b => packed.positions.get(b.id)!);
        }
        const ext = new Map<string, { x: number; y: number }>();
        parts.forEach((p, i) => { for (const [id, q] of p.positions) ext.set(id, { x: corners[i].x + q.x, y: corners[i].y + q.y }); });
        const out = placed(children, children.map(c => ext.get(c.id)!));
        // Ext corner to box corner.
        for (const c of children) {
            const q = out.positions.get(c.id)!;
            out.positions.set(c.id, { x: q.x + c.box.x - c.ext.x, y: q.y + c.box.y - c.ext.y });
        }
        return out;
    };

    const out = new Map<string, { id: string } & Rect>();
    /** Place the children of a container whose top-left corner goes to (x, y). `fit`: the free size inside a group. */
    const layout = async (container: string | undefined, x: number, y: number, fit?: { width: number; height: number }): Promise<void> => {
        const children = childrenOf(container);
        if (children.length === 0) return;
        let positions: Map<string, { x: number; y: number }> | undefined;
        if (!fit) positions = (await place(container, 'RIGHT', spacing, ASPECT)).positions;
        else {
            // In a group: the largest gap that fits, centered in the free area.
            // 40 px last (the smallest gap before the spacing setting), so that a group that fitted still fits.
            const gaps = [...new Set([...GROUP_GAPS.map(f => Math.round(f * spacing)), 40])].sort((a, b) => b - a);
            search: for (const gap of gaps) {
                for (const direction of algorithm === 'layered' ? ['RIGHT', 'DOWN'] as const : ['RIGHT'] as const) {
                    const p = await place(container, direction, gap, Math.max(0.2, fit.width / Math.max(1, fit.height)));
                    if (p.width <= fit.width && p.height <= fit.height) {
                        const dx = (fit.width - p.width) / 2, dy = (fit.height - p.height) / 2;
                        positions = new Map([...p.positions].map(([id, q]) => [id, { x: q.x + dx, y: q.y + dy }]));
                        break search;
                    }
                }
            }
        }
        for (const c of children) {
            // No fit: the child keeps its offset from the group corner (x, y are the new corner of the free area).
            const g = container ? boxes(view, 'group').find(v => v.id === container)! : undefined;
            const p = positions?.get(c.id) ?? { x: c.box.x - g!.x - PAD.left, y: c.box.y - g!.y - PAD.top };
            const box = { id: c.id, x: Math.round(x + p.x), y: Math.round(y + p.y), width: c.box.width, height: c.box.height };
            out.set(c.id, box);
            if (c.group) {
                await layout(c.id, box.x + PAD.left, box.y + PAD.top, {
                    width: c.box.width - PAD.left - PAD.right, height: c.box.height - PAD.top - PAD.bottom
                });
            }
        }
    };
    // The content keeps its top-left corner (of the drawn boxes).
    await layout(undefined, Math.min(...items.map(i => i.ext.x)), Math.min(...items.map(i => i.ext.y)));
    // The drawn extent of a laid-out item at its new place (cards with rows are drawn taller than their stored box).
    return { bounds: [...out.values()], edges: relations.filter(r => !r.derived).map(r => r.id) };
}

/** Client action: lay out the view once. One setLayout command (one undo step), then a fit of the view to the new content. */
export interface LayoutViewAction extends Action {
    kind: typeof LayoutViewAction.KIND;
    algorithm?: LayoutAlgorithm;
    /** px between boxes; absent: the default. */
    spacing?: number;
}
export namespace LayoutViewAction {
    export const KIND = 'catenaryLayoutView';
}

@injectable()
export class LayoutViewHandler implements ActionHandler {
    @inject(ViewSession) protected readonly session: ViewSession;
    readonly actionKinds = [LayoutViewAction.KIND];

    async execute(action: LayoutViewAction): Promise<Action[]> {
        const { bounds, edges } = await layoutView(this.session.part, this.session.viewId, this.session.state.showHidden, action.algorithm,
            layoutSpacing(action.spacing ?? LAYOUT_SPACING.default), this.session.state.cardScale, this.session.store.viewFigures(this.session.viewId), this.session.store.viewApplicability(this.session.part.views[this.session.viewId]));
        // The fit comes after the model update (ViewSession.edit): the viewport shows the new layout, not the area of the old one.
        if (bounds.length > 0) await this.session.edit({ kind: 'setLayout', view: this.session.viewId, bounds, clearSides: edges },
            () => [FitToScreenAction.create([], { padding: 40, maxZoom: 1, animate: true })]);
        return [];
    }
}
