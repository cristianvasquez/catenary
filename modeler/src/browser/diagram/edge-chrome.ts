// Edge rendering as plain snabbdom, without GLSP (views.ts wraps it).
// Sizes marked "screen" are divided by the zoom, so they stay constant on screen.

import { VNode } from 'snabbdom';
import type { Side } from '@catenary/model';
import { ARROW_PATHS, colorVars, s, vars } from './card-chrome';
import { EdgeStyle, Route, along, routePath } from './edge-route';

export interface Box { x: number; y: number; width: number; height: number }
export interface Pt { x: number; y: number }

export interface EdgeProps {
    source: Box;
    target: Box;
    fromSide: Side | '';     // '' : the side that faces the other card
    toSide: Side | '';
    lane: number;            // parallel edges between the same two cards
    lanes: number;
    zoom: number;
    name: string;
    details?: string;
    color: string;
    selected: boolean;
    hover: boolean;
    hidden: boolean;
    /** Shapes views: the label in parts (prefix muted, local name colored), the cardinality badge, and the logic handle when selected. */
    parts?: { text: string; color?: string }[];
    card?: string;
    invalid?: boolean;
    logicHandle?: boolean;
    /** "+ target" handle when selected: drag to a card adds it as a target ("one of"); a click opens the target picker. */
    targetHandle?: boolean;
    /** Return an ejected property to rows in all containing shape cards of this view. */
    canPutBack?: boolean;
    /** Informative arrow (from or to a note): dashed, no end handles. */
    arrow?: boolean;
    /** The dashed edge of a property shown as a row: no end handles, a button that shows the property as an edge. */
    latent?: boolean;
    /** A derived edge that shows a sh:targetSubjectsOf relation. */
    targeting?: boolean;
    /** Source and target are the same box: a loop above it. */
    self?: boolean;
    /**
     * Shapes views: out of the right side of the source, a curve, then a horizontal run into the left side of the target, with the
     * label on the run (as the shape editor prototype). Only when the target is right of the source; else the default curve.
     */
    elbow?: boolean;
    /** Route around the other boxes (edge-route.ts), drawn in `style`. Absent: the curve from card to card. */
    route?: Route;
    style?: EdgeStyle;
}

const NORMAL: Record<Side, Pt> = {
    top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }
};
const ARROW = 12;       // screen px
const END_R = 6;        // screen px, end handle radius
const LANE = 48;        // minimum screen-space lane pitch, including the cardinality badge
const LABEL = 18;       // model units; at least LABEL_MIN screen px
const LABEL_MIN = 11;

function anchor(b: Box, side: Side, offset: number): Pt {
    const span = side === 'top' || side === 'bottom' ? b.width : b.height;
    offset = Math.max(-Math.max(0, span / 2 - 16), Math.min(Math.max(0, span / 2 - 16), offset));
    switch (side) {
        case 'top': return { x: b.x + b.width / 2 + offset, y: b.y };
        case 'bottom': return { x: b.x + b.width / 2 + offset, y: b.y + b.height };
        case 'left': return { x: b.x, y: b.y + b.height / 2 + offset };
        case 'right': return { x: b.x + b.width, y: b.y + b.height / 2 + offset };
    }
}

/** Side of `b` nearest to point `p`. */
export function nearestSide(b: Box, p: Pt): Side {
    const d: [Side, number][] = [
        ['top', Math.abs(p.y - b.y)], ['bottom', Math.abs(b.y + b.height - p.y)],
        ['left', Math.abs(p.x - b.x)], ['right', Math.abs(b.x + b.width - p.x)]
    ];
    return d.reduce((m, x) => (x[1] < m[1] ? x : m))[0];
}

/** Default side: the side that faces the other node. */
export function facingSide(from: Box, to: Box): Side {
    const dx = (to.x + to.width / 2) - (from.x + from.width / 2);
    const dy = (to.y + to.height / 2) - (from.y + from.height / 2);
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
}

function arrowHead(tip: Pt, n: Pt, size: number): string {
    const base = { x: tip.x + n.x * size, y: tip.y + n.y * size };
    const w = size * 0.5;
    return `M${tip.x},${tip.y} L${base.x - n.y * w},${base.y + n.x * w} L${base.x + n.y * w},${base.y - n.x * w} Z`;
}

/** `label`: the centered path label point; logical constraints link to it. */
export interface EdgeGeometry { path: string; p1: Pt; p2: Pt; n1: Pt; n2: Pt; mid: Pt; label: Pt; tail: Pt; elbow?: boolean }

/**
 * Cubic Bézier between side midpoints, control points along the side normals (as Obsidian canvas draws it). `mid`: the label point;
 * `tail`: a point near the target end (cardinality). A self edge is a loop above the top side, one lane further out for each parallel edge.
 */
export function edgeGeometry(p: Pick<EdgeProps, 'source' | 'target' | 'fromSide' | 'toSide' | 'lane' | 'lanes' | 'zoom' | 'self' | 'elbow' | 'name' | 'route' | 'style'>): EdgeGeometry {
    const k = 1 / (p.zoom > 0 ? p.zoom : 1);
    const arrow = ARROW * k;
    const bez = (a: Pt, c1: Pt, c2: Pt, b: Pt, t: number) => {
        const u = 1 - t;
        return { x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y };
    };
    if (p.self) {
        const b = p.source, font = Math.max(LABEL, LABEL_MIN * k);
        const width = Math.max(120, p.name.length * font * 0.65 + 32 * k);
        const out = Math.max(80, 64 * k) + p.lane * Math.max(LANE * k, font * 2.5);
        const cx = b.x + b.width / 2;
        const p1 = anchor(b, 'top', Math.min(b.width / 3, 60) + p.lane * 12);
        const p2 = anchor(b, 'top', -Math.min(b.width / 3, 60) - p.lane * 12);
        const n = NORMAL.top, y = b.y - out, r = 16 * k;
        const left = Math.min(cx - width / 2 - r, p2.x - r);
        const right = Math.max(cx + width / 2 + r, p1.x + r);
        const top = { x: (left + right) / 2, y };
        const path = `M${p1.x},${p1.y} C${p1.x},${y + r} ${right},${y + r} ${right},${y + r} Q${right},${y} ${right - r},${y} L${left + r},${y} Q${left},${y} ${left},${y + r} C${left},${y + 2 * r} ${p2.x},${y + 2 * r} ${p2.x},${p2.y - arrow * 0.8}`;
        return { path, p1, p2, n1: n, n2: n, mid: top, label: top, tail: { x: left, y: y + 44 * k } };
    }
    if (p.route && p.route.points.length >= 2) {
        const points = p.route.points.map(q => ({ ...q }));
        const p1 = points[0], p2 = { ...points[points.length - 1] };
        const n1 = NORMAL[p.route.fromSide], n2 = NORMAL[p.route.toSide];
        // The line stops at the arrow base; not further back than the corner before it.
        const before = points[points.length - 2], room = Math.abs(p2.x - before.x) + Math.abs(p2.y - before.y);
        const back = Math.min(arrow * 0.8, room);
        points[points.length - 1] = { x: p2.x + n2.x * back, y: p2.y + n2.y * back };
        // Label: the middle of the longest horizontal segment that is long enough for it (the text is horizontal; a short or vertical segment
        // is often next to a card, and cards paint over edges), else of the longest segment. Tail: on the last segment, near the target.
        const len = (k: number) => Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
        const labelRoom = Math.max(80, p.name.length * 9);
        let long = 1;
        for (let k = 2; k < points.length; k++) if (len(k) > len(long)) long = k;
        let flat = 0;
        for (let k = 1; k < points.length; k++) {
            if (points[k].y === points[k - 1].y && len(k) >= labelRoom && (!flat || len(k) > len(flat))) flat = k;
        }
        if (flat) long = flat;
        const label = along([points[long - 1], points[long]], 0.5);
        const last = [points[points.length - 2], points[points.length - 1]];
        const lastLength = Math.hypot(last[1].x - last[0].x, last[1].y - last[0].y);
        return {
            path: routePath(points, p.style ?? 'orthogonal'), p1, p2, n1, n2,
            mid: label, label, tail: along(last, lastLength > 0 ? Math.max(0.3, 1 - 30 / lastLength) : 0)
        };
    }
    if (p.elbow && p.lanes === 1 && p.target.x > p.source.x + p.source.width + 60) {
        const offset = (p.lane - (p.lanes - 1) / 2) * 14;
        const p1 = { x: p.source.x + p.source.width, y: p.source.y + p.source.height / 2 };
        const p2 = { x: p.target.x, y: p.target.y + p.target.height / 2 + offset };
        const e2 = { x: p2.x - arrow * 0.8, y: p2.y };
        // The horizontal run takes the label (estimated width) and the cardinality, at most 70 % of the gap.
        const run = Math.min(Math.max(80, p.name.length * 8 + 70), (e2.x - p1.x) * 0.7);
        const h = { x: e2.x - run, y: p2.y };
        const d = Math.max(20, (h.x - p1.x) * 0.5);
        const path = `M${p1.x},${p1.y} C${p1.x + d},${p1.y} ${h.x - d},${h.y} ${h.x},${h.y} L${e2.x},${e2.y}`;
        return { path, p1, p2, n1: NORMAL.right, n2: NORMAL.left, mid: { x: (h.x + e2.x) / 2, y: h.y }, label: { x: (h.x + e2.x) / 2, y: h.y }, tail: { x: e2.x - 6 * k, y: e2.y }, elbow: true };
    }
    const fromSide = p.fromSide || facingSide(p.source, p.target);
    const toSide = p.toSide || facingSide(p.target, p.source);
    const vertical = (fromSide === 'top' || fromSide === 'bottom') && (toSide === 'top' || toSide === 'bottom');
    const font = Math.max(LABEL, LABEL_MIN * k);
    const pitch = vertical ? Math.max(LANE * k, p.name.length * font * 0.65 + 24 * k) : Math.max(LANE * k, font * 2.5);
    const offset = (p.lane - (p.lanes - 1) / 2) * pitch;
    const p1 = anchor(p.source, fromSide, offset), p2 = anchor(p.target, toSide, offset);
    const n1 = NORMAL[fromSide], n2 = NORMAL[toSide];
    // The line stops at the arrow base, so that the round line cap does not show past the tip.
    const e2 = { x: p2.x + n2.x * arrow * 0.8, y: p2.y + n2.y * arrow * 0.8 };
    const d = Math.max(40, Math.min(Math.hypot(e2.x - p1.x, e2.y - p1.y) * 0.4, 500));
    // Preserve lane separation when small cards clamp their attachment points.
    const spread = (b: Box, side: Side, at: Pt) => side === 'top' || side === 'bottom'
        ? { x: (b.x + b.width / 2 + offset - at.x) * 4 / 3, y: 0 }
        : { x: 0, y: (b.y + b.height / 2 + offset - at.y) * 4 / 3 };
    const s1 = spread(p.source, fromSide, p1), s2 = spread(p.target, toSide, p2);
    const c1 = { x: p1.x + n1.x * d + s1.x, y: p1.y + n1.y * d + s1.y };
    const c2 = { x: e2.x + n2.x * d + s2.x, y: e2.y + n2.y * d + s2.y };
    return {
        path: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${e2.x},${e2.y}`, p1, p2, n1, n2,
        mid: bez(p1, c1, c2, e2, 0.5), label: bez(p1, c1, c2, e2, 0.5), tail: bez(p1, c1, c2, e2, 0.9)
    };
}

/** A hovered or selected edge shows a ring at each end, outside the card (cards paint over edges): drag one to another card or side. */
export function renderEdge(p: EdgeProps): VNode {
    const k = 1 / (p.zoom > 0 ? p.zoom : 1);
    const { path, p1, p2, n1, n2, mid, label: at, tail, elbow = false } = edgeGeometry(p);
    const fontSize = Math.max(LABEL, LABEL_MIN * k);
    const ends = p.arrow || p.latent || p.targeting || (!p.selected && !p.hover) ? [] : ([['source', p1, n1, END_R + 3], ['target', p2, n2, ARROW + END_R + 2]] as const).map(([end, at, n, gap]) =>
        s('circle', {
            class: { 'edge-end': true }, attrs: { 'data-end': end, cx: at.x + n.x * gap * k, cy: at.y + n.y * gap * k, r: END_R * k, 'stroke-width': 2 * k }
        }));
    const label = p.parts
        ? s('text', { class: { 'edge-label': true, parts: true }, attrs: { x: at.x, y: at.y - fontSize * 0.7 }, style: { fontSize: `${fontSize}px`, strokeWidth: `${fontSize * 0.4}px` } },
            p.parts.map(x => s('tspan', { class: { muted: !x.color }, style: x.color ? { fill: x.color } : {} }, [x.text])))
        : s('text', { class: { 'edge-label': true }, attrs: { x: mid.x, y: mid.y }, style: { fontSize: `${fontSize}px`, strokeWidth: `${fontSize * 0.4}px` } }, [p.hidden ? `${p.name} (hidden)` : p.name]);
    const cardW = Math.max(26, 8 + (p.card?.length ?? 0) * 8) * k, cardH = 18 * k;
    // Below the line near the target end; a self loop: above the arrow.
    const cardAt = p.self ? { x: tail.x - cardW / 2 - 6 * k, y: tail.y - 12 * k }
        : { x: tail.x - (elbow ? cardW / 2 : 0), y: tail.y + 13 * k };
    const card = p.card === undefined ? [] : [s('g', { class: { 'edge-card': true }, attrs: { 'data-card': '1', transform: `translate(${cardAt.x},${cardAt.y})` } }, [
        s('title', {}, ['Cardinality: click for the next one (0..* → 0..1 → 1 → 1..*)']),
        s('rect', { attrs: { x: -cardW / 2, y: -cardH / 2, width: cardW, height: cardH, rx: cardH / 2 } }),
        s('text', { attrs: { x: 0, y: 0 }, style: { fontSize: `${12 * k}px` } }, [p.card])
    ])];
    const putBack = p.canPutBack ? [s('g', { class: { 'row-in': true }, attrs: { transform: `translate(${cardAt.x - cardW / 2 - 12 * k},${cardAt.y})` } }, [
        s('title', {}, ['Show as a row in all containing shapes in this view']),
        s('circle', { attrs: { r: 8 * k, 'stroke-width': 1.5 * k } }),
        s('path', { attrs: { d: ARROW_PATHS.in, transform: `scale(${k})`, 'stroke-width': 1.5 } })
    ])] : [];
    const handle = p.logicHandle && p.selected ? [s('g', { class: { 'logic-handle': true }, attrs: { transform: `translate(${at.x},${at.y - fontSize * 1.7 - 8 * k})` } }, [
        s('title', {}, ['Drag to another edge of this shape: logical constraint (or)']),
        s('circle', { attrs: { r: 8 * k, 'stroke-width': 1.5 * k } }),
        s('circle', { class: { dot: true }, attrs: { r: 3 * k } })
    ])] : [];
    const showAsEdge = p.latent ? [s('g', { class: { 'latent-out': true }, attrs: { transform: `translate(${at.x},${at.y + 14 * k})` } }, [
        s('title', {}, ['Show as an edge in this view']),
        s('circle', { attrs: { r: 8 * k, 'stroke-width': 1.5 * k } }),
        s('path', { attrs: { d: ARROW_PATHS.out, transform: `scale(${k})`, 'stroke-width': 1.5 } })
    ])] : [];
    // Right of the cardinality badge, as the return arrow is left of it.
    const addTarget = p.targetHandle && p.selected ? [s('g', { class: { 'target-handle': true }, attrs: { transform: `translate(${cardAt.x + cardW / 2 + 12 * k},${cardAt.y})` } }, [
        s('title', {}, ['Add a target: drag to a card, or click to pick one (each value is one of the targets)']),
        s('circle', { attrs: { r: 8 * k, 'stroke-width': 1.5 * k } }),
        s('path', { attrs: { d: 'M-4,0 L4,0 M0,-4 L0,4', transform: `scale(${k})`, 'stroke-width': 1.5 } })
    ])] : [];
    return s('g', {
        class: { 'catenary-edge': true, 'arrow-edge': !!p.arrow, 'latent-edge': !!p.latent, 'targeting-edge': !!p.targeting, colored: !!p.color, selected: p.selected, mouseover: p.hover, 'hidden-edge': p.hidden, invalid: !!p.invalid, property: !!p.parts },
        style: vars(colorVars(p.color))
    }, [
        ...(p.details ? [s('title', {}, [p.details])] : []),
        s('path', { class: { hit: true }, attrs: { d: path } }),
        s('path', { class: { line: true }, attrs: { d: path } }),
        s('path', { class: { arrow: true }, attrs: { d: arrowHead(p2, n2, ARROW * k) } }),
        label,
        ...card,
        ...putBack,
        ...showAsEdge,
        ...handle,
        ...addTarget,
        ...ends
    ]);
}

/**
 * Center of a logical constraint circle: the middle of the labels of its member edges (one member: above its label). `taken`: centers of
 * the circles drawn before it; a circle closer than 3 radii to one of them moves down until it is clear.
 */
export function logicCenter(mids: Pt[], zoom: number, taken: Pt[] = []): Pt | undefined {
    if (!mids.length) return undefined;
    const k = 1 / (zoom > 0 ? zoom : 1);
    const c = mids.length === 1
        ? { x: mids[0].x, y: mids[0].y - 36 * k }
        : { x: mids.reduce((a, m) => a + m.x, 0) / mids.length + 24 * k, y: mids.reduce((a, m) => a + m.y, 0) / mids.length };
    for (let i = 0; i < 20 && taken.some(t => Math.hypot(t.x - c.x, t.y - c.y) < 30 * k); i++) c.y += 30 * k;
    return c;
}

/** Logical constraint: a circle at `center`, dashed lines to the label of each member edge. */
export function renderLogic(p: { mids: Pt[]; center?: Pt; operator: string; zoom: number; selected: boolean; hover: boolean }): VNode {
    const k = 1 / (p.zoom > 0 ? p.zoom : 1);
    const c = p.center;
    if (!c) return s('g', {}, []);
    return s('g', { class: { 'catenary-logic': true, selected: p.selected, mouseover: p.hover } }, [
        ...p.mids.map(m => s('line', { class: { link: true }, attrs: { x1: c.x, y1: c.y, x2: m.x, y2: m.y, 'stroke-width': 1.5 * k, 'stroke-dasharray': `${4 * k} ${3 * k}` } })),
        s('circle', { class: { ring: true }, attrs: { cx: c.x, cy: c.y, r: 10 * k, 'stroke-width': 2 * k } }),
        s('circle', { class: { dot: true }, attrs: { cx: c.x, cy: c.y, r: 3.5 * k } }),
        s('text', { attrs: { x: c.x + 13 * k, y: c.y + 13 * k }, style: { fontSize: `${13 * k}px` } }, [p.operator])
    ]);
}
