// Geometry of an edge route: the ports on the cards, the bends (vertices) that the view stores, and the two styles (UI §7.4).
// direct: straight segments through the points. curved: a smooth curve through them, leaving and entering the cards along the side
// normals. Nothing routes around cards: the user bends an edge with its vertices. No imports: tested in Node (modeler/test/edge-route.test.ts).

export type Side = 'top' | 'right' | 'bottom' | 'left';
export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

export const EDGE_STYLES = ['curved', 'direct'] as const;
export type EdgeStyle = typeof EDGE_STYLES[number];

export const NORMAL: Record<Side, Pt> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

/** Side of `b` that faces point `p` (the center of the other card, or the first vertex). */
export function facingPoint(b: Rect, p: Pt): Side {
    const dx = p.x - (b.x + b.width / 2), dy = p.y - (b.y + b.height / 2);
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
}

/** Side of `b` nearest to point `p`. */
export function nearestSide(b: Rect, p: Pt): Side {
    const d: [Side, number][] = [
        ['top', Math.abs(p.y - b.y)], ['bottom', Math.abs(b.y + b.height - p.y)],
        ['left', Math.abs(p.x - b.x)], ['right', Math.abs(b.x + b.width - p.x)]
    ];
    return d.reduce((m, x) => (x[1] < m[1] ? x : m))[0];
}

/** Point on a side of `b`, `offset` from its middle, kept 16 units inside the corners. */
export function port(b: Rect, side: Side, offset: number): Pt {
    const span = side === 'top' || side === 'bottom' ? b.width : b.height;
    offset = Math.max(-Math.max(0, span / 2 - 16), Math.min(Math.max(0, span / 2 - 16), offset));
    switch (side) {
        case 'top': return { x: b.x + b.width / 2 + offset, y: b.y };
        case 'bottom': return { x: b.x + b.width / 2 + offset, y: b.y + b.height };
        case 'left': return { x: b.x, y: b.y + b.height / 2 + offset };
        case 'right': return { x: b.x + b.width, y: b.y + b.height / 2 + offset };
    }
}

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Point at `fraction` of the length of a polyline. */
export function along(points: Pt[], fraction: number): Pt {
    const lengths = points.slice(1).map((p, k) => dist(points[k], p));
    let rest = lengths.reduce((a, b) => a + b, 0) * fraction;
    for (let k = 0; k < lengths.length; k++) {
        if (rest <= lengths[k] || k === lengths.length - 1) {
            const t = lengths[k] ? Math.min(1, rest / lengths[k]) : 0;
            return { x: points[k].x + (points[k + 1].x - points[k].x) * t, y: points[k].y + (points[k + 1].y - points[k].y) * t };
        }
        rest -= lengths[k];
    }
    return points[0];
}

/** Index of the segment of a polyline nearest to `p`: a new vertex goes after point `index`. */
export function nearestSegment(points: Pt[], p: Pt): number {
    let best = 0, bestD = Infinity;
    for (let k = 0; k + 1 < points.length; k++) {
        const a = points[k], b = points[k + 1];
        const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
        const d = dist(p, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        if (d < bestD) { bestD = d; best = k; }
    }
    return best;
}

/** One cubic segment of a curved route. */
export interface Cubic { a: Pt; c1: Pt; c2: Pt; b: Pt }

export function cubicAt(s: Cubic, t: number): Pt {
    const u = 1 - t;
    return {
        x: u * u * u * s.a.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.b.x,
        y: u * u * u * s.a.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.b.y
    };
}

/**
 * Cubic segments through `points` (the port of the source, the vertices, the arrow base). The curve leaves the first point along `n1`
 * and enters the last point against `n2` (the side normals). At a vertex the tangent follows the chord of its neighbors. Each control
 * point is at 0.4 of the segment length (at least 40, at most 500 units at the ends), so the curve stays near its polyline. `s1`, `s2`:
 * an extra push on the end tangents (lane separation on a small card).
 */
export function curveSegments(points: Pt[], n1: Pt, n2: Pt, s1: Pt = { x: 0, y: 0 }, s2: Pt = { x: 0, y: 0 }): Cubic[] {
    const n = points.length - 1;
    if (n < 1) return [];
    const len = (k: number) => dist(points[k], points[k + 1]);
    const unit = (v: Pt) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
    // Tangent direction at each point.
    const dir = (k: number): Pt => k === 0 ? n1 : k === n ? { x: -n2.x, y: -n2.y } : unit({ x: points[k + 1].x - points[k - 1].x, y: points[k + 1].y - points[k - 1].y });
    const reach = (k: number, l: number) => k === 0 || k === n ? Math.max(40, Math.min(l * 0.4, 500)) : l * 0.4;
    const out: Cubic[] = [];
    for (let k = 0; k < n; k++) {
        const a = points[k], b = points[k + 1], l = len(k), da = dir(k), db = dir(k + 1);
        const ra = reach(k, l), rb = reach(k + 1, l);
        const c1 = { x: a.x + da.x * ra + (k === 0 ? s1.x : 0), y: a.y + da.y * ra + (k === 0 ? s1.y : 0) };
        const c2 = { x: b.x - db.x * rb + (k + 1 === n ? s2.x : 0), y: b.y - db.y * rb + (k + 1 === n ? s2.y : 0) };
        out.push({ a, c1, c2, b });
    }
    return out;
}

/** The point at `fraction` of a curved route, by the length of its polyline (each segment takes its share of the polyline length). */
export function curveAt(segments: Cubic[], fraction: number): Pt {
    const lengths = segments.map(s => dist(s.a, s.b));
    let rest = lengths.reduce((a, b) => a + b, 0) * Math.max(0, Math.min(1, fraction));
    for (let k = 0; k < segments.length; k++) {
        if (rest <= lengths[k] || k === segments.length - 1) return cubicAt(segments[k], lengths[k] ? Math.min(1, rest / lengths[k]) : 0);
        rest -= lengths[k];
    }
    return segments[0]?.a ?? { x: 0, y: 0 };
}

const f = (p: Pt) => `${p.x},${p.y}`;

export function curvePath(segments: Cubic[]): string {
    if (!segments.length) return '';
    return `M${f(segments[0].a)}` + segments.map(s => ` C${f(s.c1)} ${f(s.c2)} ${f(s.b)}`).join('');
}

export function linePath(points: Pt[]): string {
    return points.length < 2 ? '' : `M${points.map(f).join(' L')}`;
}

/** The sides that a route leaves and enters: the side the view sets, else the side that faces the first (last) bend, else the other box. */
export function routeSides(source: Rect, target: Rect, fromSide: Side | '', toSide: Side | '', vertices: readonly Pt[], self: boolean): { fromSide: Side; toSide: Side } {
    const first = vertices[0], last = vertices[vertices.length - 1];
    const center = (b: Rect) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    if (self && !vertices.length) return { fromSide: 'top', toSide: 'top' };
    return {
        fromSide: fromSide || facingPoint(source, first ?? center(target)),
        toSide: toSide || facingPoint(target, last ?? center(source))
    };
}

export interface FanEdge {
    id: string;
    source: string;
    target: string;
    sourceBox: Rect;
    targetBox: Rect;
    fromSide: Side | '';
    toSide: Side | '';
    vertices: readonly Pt[];
    name: string;
}

/**
 * Port offsets of the edges of a diagram (UI §7.4): the edges that leave or enter one side of one box fan out along that side, in the
 * order of the point they go to (the first bend, else the other box), so that no two share a port. The pitch is readable on screen:
 * `pitch` screen px, or the width of the longest label on a top or bottom side. A self edge without bends keeps its own arch ports.
 */
export function fanOut(edges: readonly FanEdge[], zoom: number, pitch = 48, font = 18): Map<string, { from: number; to: number }> {
    const k = 1 / (zoom > 0 ? zoom : 1);
    type Entry = { id: string; end: 'from' | 'to'; at: number; name: string };
    const groups = new Map<string, { side: Side; entries: Entry[] }>();
    const add = (box: string, side: Side, e: Entry) => {
        const key = `${box} ${side}`;
        const g = groups.get(key) ?? groups.set(key, { side, entries: [] }).get(key)!;
        g.entries.push(e);
    };
    const toward = (p: Pt, side: Side) => side === 'top' || side === 'bottom' ? p.x : p.y;
    const center = (b: Rect) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    for (const e of edges) {
        const self = e.source === e.target;
        if (self && !e.vertices.length) continue;
        const { fromSide, toSide } = routeSides(e.sourceBox, e.targetBox, e.fromSide, e.toSide, e.vertices, self);
        add(e.source, fromSide, { id: e.id, end: 'from', at: toward(e.vertices[0] ?? center(e.targetBox), fromSide), name: e.name });
        add(e.target, toSide, { id: e.id, end: 'to', at: toward(e.vertices[e.vertices.length - 1] ?? center(e.sourceBox), toSide), name: e.name });
    }
    const out = new Map<string, { from: number; to: number }>();
    const fontK = Math.max(font, 11 * k);
    for (const { side, entries } of groups.values()) {
        entries.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id) || a.end.localeCompare(b.end));
        const longest = Math.max(0, ...entries.map(e => e.name.length));
        const step = side === 'top' || side === 'bottom' ? Math.max(pitch * k, longest * fontK * 0.65 + 24 * k) : Math.max(pitch * k, fontK * 2.5);
        entries.forEach((e, i) => {
            const o = out.get(e.id) ?? out.set(e.id, { from: 0, to: 0 }).get(e.id)!;
            o[e.end] = (i - (entries.length - 1) / 2) * step;
        });
    }
    return out;
}
