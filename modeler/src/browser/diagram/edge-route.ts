// Edge routes around the boxes of a view. Computed at render time from the box bounds; nothing is stored in the model.
// Orthogonal router: shortest path on a grid made from the box sides (at distance MARGIN) and the ports of the edges.
// Cost: length, a penalty for each bend, a penalty for length in the margin of a box (it goes through narrow gaps only when there
// is no other way), a penalty for a segment that another edge uses already, and a penalty for each crossing of an earlier route (the
// edges are routed in the given order). The boxes themselves are blocked.
// Overlapping segments of different routes on one line are then moved apart (nudge).
// Polyline and curved start from the orthogonal route and remove the corners that a straight segment can skip without touching a box;
// curved then rounds the corners (routePath).
// No imports: tested in Node (modeler/test/edge-route.test.ts).

export type Side = 'top' | 'right' | 'bottom' | 'left';
export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

export const EDGE_STYLES = ['orthogonal', 'polyline', 'curved', 'direct'] as const;
export type EdgeStyle = typeof EDGE_STYLES[number];

export interface RouteRequest {
    id: string;
    source: string;
    target: string;
    /** '' or absent: the router chooses the side. */
    fromSide?: Side | '';
    toSide?: Side | '';
    lane: number;
    lanes: number;
}

/** `points`: from the port on the source side to the port on the target side. */
export interface Route { points: Pt[]; fromSide: Side; toSide: Side }

export const MARGIN = 24;       // model units between a route and a box
const LANE = 30;                // model units between parallel edges (as edge-chrome.ts)
const BEND = 80;                // cost of one bend, in model units of length
const NEAR = 4;                 // cost factor for length inside the margin of a box
const SHARED = 1.5;             // cost factor for a segment that an earlier route uses
const CROSS = 300;              // cost of crossing an earlier route
const NUDGE = 10;               // model units between routes on the same line

export const NORMAL: Record<Side, Pt> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];
// Grid directions: 0 right, 1 down, 2 left, 3 up.
const DIRS: Pt[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const dirOf = (n: Pt) => DIRS.findIndex(d => d.x === n.x && d.y === n.y);

export function port(b: Rect, side: Side, offset: number): Pt {
    switch (side) {
        case 'top': return { x: b.x + b.width / 2 + offset, y: b.y };
        case 'bottom': return { x: b.x + b.width / 2 + offset, y: b.y + b.height };
        case 'left': return { x: b.x, y: b.y + b.height / 2 + offset };
        case 'right': return { x: b.x + b.width, y: b.y + b.height / 2 + offset };
    }
}

const inside = (p: Pt, r: Rect, pad: number) => p.x > r.x - pad && p.x < r.x + r.width + pad && p.y > r.y - pad && p.y < r.y + r.height + pad;
const contains = (outer: Rect, inner: Rect) =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** Min-heap of [cost, state]. */
class Heap {
    private readonly items: [number, number][] = [];
    get size(): number { return this.items.length; }
    push(cost: number, state: number): void {
        const a = this.items;
        a.push([cost, state]);
        for (let i = a.length - 1; i > 0;) {
            const p = (i - 1) >> 1;
            if (a[p][0] <= a[i][0]) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }
    pop(): [number, number] {
        const a = this.items, top = a[0], last = a.pop()!;
        if (a.length) {
            a[0] = last;
            for (let i = 0; ;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && a[l][0] < a[m][0]) m = l;
                if (r < a.length && a[r][0] < a[m][0]) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]];
                i = m;
            }
        }
        return top;
    }
}

/** Removes points on a straight line between their neighbours, and repeated points. */
function simplify(points: Pt[]): Pt[] {
    const out: Pt[] = [];
    for (const p of points) {
        if (out.length && out[out.length - 1].x === p.x && out[out.length - 1].y === p.y) continue;
        if (out.length >= 2) {
            const a = out[out.length - 2], b = out[out.length - 1];
            if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out.pop();
        }
        out.push(p);
    }
    return out;
}

/** True when segment a–b crosses the inside of r (Liang–Barsky clip against the open rectangle). */
export function segmentHits(a: Pt, b: Pt, r: Rect): boolean {
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y;
    const clip = (p: number, q: number) => {
        if (p === 0) return q > 0;
        const t = q / p;
        if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
        return true;
    };
    const e = 0.5;
    if (!(clip(-dx, a.x - (r.x + e)) && clip(dx, r.x + r.width - e - a.x) && clip(-dy, a.y - (r.y + e)) && clip(dy, r.y + r.height - e - a.y))) return false;
    return t1 - t0 > 1e-9;
}

/**
 * Routes of `edges` between the boxes of `boxes` (every box is an obstacle for the edges that do not end at it or in it). A box that
 * contains the source or the target (a group) is not an obstacle for that edge. An edge from a box to itself, or with an end that is not in
 * `boxes`, gets no route; also an edge that finds no path. The caller draws these as before.
 */
export function routeEdges(boxes: Map<string, Rect>, edges: RouteRequest[], style: EdgeStyle = 'orthogonal'): Map<string, Route> {
    const routes = new Map<string, Route>();
    if (style === 'direct') return routes;
    const rects = [...boxes.values()];
    const ends = edges.filter(e => e.source !== e.target && boxes.has(e.source) && boxes.has(e.target));
    if (!ends.length) return routes;

    // Grid lines: the sides of each box at MARGIN, and the ports (the middle of each side, with the lane offsets).
    const xs = new Set<number>(), ys = new Set<number>();
    for (const r of rects) {
        xs.add(r.x - MARGIN); xs.add(r.x + r.width + MARGIN);
        ys.add(r.y - MARGIN); ys.add(r.y + r.height + MARGIN);
    }
    const offset = (e: RouteRequest) => (e.lane - (e.lanes - 1) / 2) * LANE;
    for (const e of ends) for (const id of [e.source, e.target]) {
        const r = boxes.get(id)!;
        xs.add(r.x + r.width / 2 + offset(e));
        ys.add(r.y + r.height / 2 + offset(e));
    }
    const X = [...xs].sort((a, b) => a - b), Y = [...ys].sort((a, b) => a - b);
    const xi = new Map(X.map((x, i) => [x, i])), yi = new Map(Y.map((y, i) => [y, i]));
    const W = X.length, H = Y.length, N = W * H;
    const node = (i: number, j: number) => j * W + i;
    const at = (n: number): Pt => ({ x: X[n % W], y: Y[Math.floor(n / W)] });

    // Cost factor of the segment from each node in each direction: 0 blocked (inside a box), NEAR in a margin, 1 free. Per edge, the
    // boxes that contain its source or target are left out (recomputed only for those edges).
    const segments = (skip: Set<Rect>) => {
        const cost = new Float32Array(N * 4);
        for (let n = 0; n < N; n++) {
            const i = n % W, j = Math.floor(n / W);
            for (let d = 0; d < 2; d++) {
                const i2 = i + DIRS[d].x, j2 = j + DIRS[d].y;
                if (i2 >= W || j2 >= H) continue;
                // The grid has a line on each margin border, so the middle of a segment tells where the whole segment is.
                const mid = { x: (X[i] + X[i2]) / 2, y: (Y[j] + Y[j2]) / 2 };
                let f = 1;
                for (const r of rects) {
                    if (skip.has(r)) continue;
                    if (inside(mid, r, 0)) { f = 0; break; }
                    if (inside(mid, r, MARGIN)) f = NEAR;
                }
                cost[n * 4 + d] = f;
                cost[node(i2, j2) * 4 + d + 2] = f;
            }
        }
        return cost;
    };
    const base = segments(new Set());
    const used = new Set<string>();
    const free = new Map<string, Rect[]>();
    // Nodes on earlier routes, by the axis of the route there (0 horizontal, 1 vertical): a move on the other axis through one crosses it.
    const on = [new Uint8Array(N), new Uint8Array(N)];
    const segKey = (a: number, b: number) => a < b ? `${a} ${b}` : `${b} ${a}`;

    for (const e of ends) {
        const s = boxes.get(e.source)!, t = boxes.get(e.target)!;
        const skip = new Set(rects.filter(r => r !== s && r !== t && (contains(r, s) || contains(r, t))));
        const cost = skip.size ? segments(skip) : base;
        const off = offset(e);
        // A port and the stub point MARGIN out from it; both on grid lines.
        const stub = (b: Rect, side: Side) => {
            const p = port(b, side, off), n = NORMAL[side];
            const q = { x: p.x + n.x * MARGIN, y: p.y + n.y * MARGIN };
            const i = xi.get(q.x), j = yi.get(q.y);
            return i === undefined || j === undefined ? undefined : { side, p, n, at: node(i, j) };
        };
        const starts = (e.fromSide ? [e.fromSide] : SIDES).map(side => stub(s, side)).filter(x => x !== undefined);
        const goals = new Map<number, { side: Side; p: Pt; n: Pt }[]>();
        for (const side of e.toSide ? [e.toSide] : SIDES) {
            const g = stub(t, side);
            if (g) goals.set(g.at, [...(goals.get(g.at) ?? []), g]);
        }
        // A*: state = node * 4 + direction of arrival.
        const best = new Float64Array(N * 4).fill(Infinity);
        const prev = new Int32Array(N * 4).fill(-1);
        const heap = new Heap();
        const goalPts = [...goals.keys()].map(at);
        const h = (n: number) => { const p = at(n); return Math.min(...goalPts.map(g => Math.abs(g.x - p.x) + Math.abs(g.y - p.y))); };
        for (const st of starts) {
            const state = st.at * 4 + dirOf(st.n);
            if (MARGIN < best[state]) { best[state] = MARGIN; heap.push(MARGIN + h(st.at), state); }
        }
        let end: { state: number; side: Side; p: Pt } | undefined;
        let endCost = Infinity;
        while (heap.size) {
            const [f, state] = heap.pop();
            if (f >= endCost) break;
            const n = state >> 2, d = state & 3, g = best[state];
            if (f - h(n) > g + 1e-6) continue;
            for (const goal of goals.get(n) ?? []) {
                // The last segment goes into the target: against the normal of its side.
                const into = dirOf({ x: -goal.n.x, y: -goal.n.y });
                if (d === (into + 2) % 4) continue;
                const total = g + MARGIN + (d === into ? 0 : BEND);
                if (total < endCost) { endCost = total; end = { state, side: goal.side, p: goal.p }; }
            }
            const i = n % W, j = Math.floor(n / W);
            for (let d2 = 0; d2 < 4; d2++) {
                if (d2 === (d + 2) % 4) continue;
                const f2 = cost[n * 4 + d2];
                if (!f2) continue;
                const i2 = i + DIRS[d2].x, j2 = j + DIRS[d2].y;
                const n2 = node(i2, j2);
                const len = Math.abs(X[i2] - X[i]) + Math.abs(Y[j2] - Y[j]);
                const g2 = g + len * f2 * (used.has(segKey(n, n2)) ? SHARED : 1) + (d2 === d ? 0 : BEND) + (on[1 - (d2 & 1)][n2] ? CROSS : 0);
                const s2 = n2 * 4 + d2;
                if (g2 < best[s2]) { best[s2] = g2; prev[s2] = state; heap.push(g2 + h(n2), s2); }
            }
        }
        if (!end) continue;
        const states: number[] = [];
        for (let st = end.state; st >= 0; st = prev[st]) states.push(st);
        states.reverse();
        const nodes = states.map(st => st >> 2);
        for (let k = 1; k < nodes.length; k++) {
            used.add(segKey(nodes[k - 1], nodes[k]));
            const axis = states[k] & 1;
            on[axis][nodes[k - 1]] = 1; on[axis][nodes[k]] = 1;
        }
        const start = starts.find(st => st.at === nodes[0] && dirOf(st.n) === (states[0] & 3))!;
        routes.set(e.id, { points: simplify([start.p, ...nodes.map(at), end.p]), fromSide: start.side, toSide: end.side });
        free.set(e.id, rects.filter(r => !skip.has(r)));
    }
    nudge(routes, free);
    if (style !== 'orthogonal') for (const [id, route] of routes) route.points = shortcut(route.points, free.get(id)!);
    return routes;
}

/**
 * Segments of different routes on the same line that overlap are moved apart, NUDGE between them (less when there are many, never
 * MARGIN or more from the line). The first and the last segment of a route stay: they end at the ports. A move that would touch a box is
 * not made.
 */
function nudge(routes: Map<string, Route>, free: Map<string, Rect[]>): void {
    type Seg = { id: string; points: Pt[]; k: number; lo: number; hi: number };
    const lines = new Map<string, Seg[]>();
    for (const [id, route] of routes) {
        const p = route.points;
        for (let k = 1; k < p.length - 2; k++) {
            const a = p[k], b = p[k + 1];
            const key = a.y === b.y ? `h${a.y}` : a.x === b.x ? `v${a.x}` : undefined;
            if (!key) continue;
            const horizontal = key[0] === 'h';
            const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y), hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
            lines.set(key, [...(lines.get(key) ?? []), { id, points: p, k, lo, hi }]);
        }
    }
    for (const [key, segs] of lines) {
        segs.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
        // Clusters of overlapping segments.
        const clusters: Seg[][] = [];
        let end = -Infinity;
        for (const seg of segs) {
            if (seg.lo < end - 1e-6) { clusters[clusters.length - 1].push(seg); end = Math.max(end, seg.hi); }
            else { clusters.push([seg]); end = seg.hi; }
        }
        for (const cluster of clusters) {
            if (new Set(cluster.map(c => c.id)).size < 2) continue;
            const step = Math.min(NUDGE, (1.6 * MARGIN) / (cluster.length - 1));
            cluster.forEach((seg, i) => {
                const off = (i - (cluster.length - 1) / 2) * step;
                const a = seg.points[seg.k], b = seg.points[seg.k + 1];
                const moved = key[0] === 'h' ? [{ x: a.x, y: a.y + off }, { x: b.x, y: b.y + off }] : [{ x: a.x + off, y: a.y }, { x: b.x + off, y: b.y }];
                const p = seg.points;
                // The segment and the two segments at its ends (they get longer or shorter) must stay clear of the boxes.
                const check: [Pt, Pt][] = [[p[seg.k - 1], moved[0]], [moved[0], moved[1]], [moved[1], p[seg.k + 2]]];
                if (check.some(([u, v]) => free.get(seg.id)!.some(r => segmentHits(u, v, r)))) return;
                p[seg.k] = moved[0];
                p[seg.k + 1] = moved[1];
            });
        }
    }
}

/**
 * Polyline and curved: from each corner, go straight to the farthest later corner when the segment touches no box. The first and the last
 * segment (the stubs out of the source and into the target) stay, so that the ends leave and enter their sides at a right angle.
 */
function shortcut(points: Pt[], rects: Rect[]): Pt[] {
    if (points.length <= 4) return points;
    const clear = (a: Pt, b: Pt) => rects.every(r => !segmentHits(a, b, r));
    const out = [points[0], points[1]];
    let i = 1;
    const last = points.length - 2;
    while (i < last) {
        let j = last;
        while (j > i + 1 && !clear(points[i], points[j])) j--;
        out.push(points[j]);
        i = j;
    }
    out.push(points[points.length - 1]);
    return out;
}

/** Point at `fraction` of the length of a polyline. */
export function along(points: Pt[], fraction: number): Pt {
    const lengths = points.slice(1).map((p, k) => Math.hypot(p.x - points[k].x, p.y - points[k].y));
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

/**
 * SVG path of a route in a style. Orthogonal: rounded corners (radius at most `radius`). Polyline: sharp corners. Curved: the polyline with
 * large rounded corners (at most half of each segment); each curve stays in the triangle of its corner, so it does not swing out over a box.
 */
export function routePath(points: Pt[], style: EdgeStyle, radius = 16): string {
    if (points.length < 2) return '';
    const f = (p: Pt) => `${p.x},${p.y}`;
    if (style === 'polyline' || style === 'direct') return `M${points.map(f).join(' L')}`;
    const max = style === 'curved' ? Infinity : radius;
    let d = `M${f(points[0])}`;
    for (let k = 1; k < points.length - 1; k++) {
        const a = points[k - 1], b = points[k], c = points[k + 1];
        const la = Math.hypot(b.x - a.x, b.y - a.y), lc = Math.hypot(c.x - b.x, c.y - b.y);
        // Half of a segment at most: the next corner takes the other half.
        const r = Math.min(max, la / 2, lc / 2);
        const p = { x: b.x + (a.x - b.x) * r / (la || 1), y: b.y + (a.y - b.y) * r / (la || 1) };
        const q = { x: b.x + (c.x - b.x) * r / (lc || 1), y: b.y + (c.y - b.y) * r / (lc || 1) };
        d += ` L${f(p)} Q${f(b)} ${f(q)}`;
    }
    return `${d} L${f(points[points.length - 1])}`;
}
