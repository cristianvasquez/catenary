import { expect, it } from 'vitest';
import { MARGIN, Pt, Rect, routeEdges, routePath, segmentHits } from '../src/browser/diagram/edge-route';
import { edgeGeometry } from '../src/browser/diagram/edge-chrome';

const box = (x: number, y: number, width = 200, height = 100): Rect => ({ x, y, width, height });
const onSide = (p: Pt, r: Rect) =>
    ((p.x === r.x || p.x === r.x + r.width) && p.y >= r.y && p.y <= r.y + r.height) || ((p.y === r.y || p.y === r.y + r.height) && p.x >= r.x && p.x <= r.x + r.width);
const segments = (points: Pt[]) => points.slice(1).map((b, k) => [points[k], b] as const);

// a and c on one row, b between them: the straight line from a to c goes through b.
const row = new Map([['a', box(0, 0)], ['b', box(400, 0)], ['c', box(800, 0)]]);

it('an orthogonal route goes around the box between the ends, from side to side, with right angles only', () => {
    const route = routeEdges(row, [{ id: 'e', source: 'a', target: 'c', lane: 0, lanes: 1 }]).get('e')!;
    expect(route).toBeDefined();
    expect(onSide(route.points[0], row.get('a')!)).toBe(true);
    expect(onSide(route.points[route.points.length - 1], row.get('c')!)).toBe(true);
    for (const [a, b] of segments(route.points)) {
        expect(a.x === b.x || a.y === b.y, `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(true);
        for (const r of row.values()) expect(segmentHits(a, b, r)).toBe(false);
    }
    // It keeps MARGIN from b.
    const b = row.get('b')!;
    for (const p of route.points) expect(p.y <= b.y - MARGIN || p.y >= b.y + b.height + MARGIN || p.x <= b.x - MARGIN || p.x >= b.x + b.width + MARGIN).toBe(true);
});

it('keeps the sides that the view sets', () => {
    const route = routeEdges(row, [{ id: 'e', source: 'a', target: 'c', fromSide: 'bottom', toSide: 'top', lane: 0, lanes: 1 }]).get('e')!;
    expect(route).toMatchObject({ fromSide: 'bottom', toSide: 'top' });
    expect(route.points[0]).toEqual({ x: 100, y: 100 });
    expect(route.points[route.points.length - 1]).toEqual({ x: 900, y: 0 });
});

it('a box that contains an end (a group) is not an obstacle for that edge; other boxes are', () => {
    const boxes = new Map([['group', box(-50, -50, 1000, 300)], ['a', box(0, 0)], ['b', box(400, 0)], ['c', box(1200, 0)]]);
    const route = routeEdges(boxes, [{ id: 'e', source: 'a', target: 'c', lane: 0, lanes: 1 }]).get('e')!;
    expect(route).toBeDefined();
    for (const [p, q] of segments(route.points)) expect(segmentHits(p, q, boxes.get('b')!)).toBe(false);
});

it('direct, a self edge and an unknown end get no route', () => {
    expect(routeEdges(row, [{ id: 'e', source: 'a', target: 'c', lane: 0, lanes: 1 }], 'direct').size).toBe(0);
    expect(routeEdges(row, [{ id: 's', source: 'a', target: 'a', lane: 0, lanes: 1 }, { id: 'u', source: 'a', target: 'x', lane: 0, lanes: 1 }]).size).toBe(0);
});

it('polyline removes corners only where the straight segment touches no box', () => {
    const boxes = new Map([['a', box(0, 0)], ['b', box(400, 150)], ['c', box(800, 400)]]);
    const ortho = routeEdges(boxes, [{ id: 'e', source: 'a', target: 'c', lane: 0, lanes: 1 }]).get('e')!;
    const poly = routeEdges(boxes, [{ id: 'e', source: 'a', target: 'c', lane: 0, lanes: 1 }], 'polyline').get('e')!;
    expect(poly.points.length).toBeLessThanOrEqual(ortho.points.length);
    for (const [p, q] of segments(poly.points)) for (const r of boxes.values()) expect(segmentHits(p, q, r)).toBe(false);
});

it('parallel edges get separate ports (lanes)', () => {
    const two = new Map([['a', box(0, 0)], ['c', box(800, 0)]]);
    const routes = routeEdges(two, [0, 1].map(lane => ({ id: `e${lane}`, source: 'a', target: 'c', lane, lanes: 2 })));
    expect(routes.get('e0')!.points[0]).not.toEqual(routes.get('e1')!.points[0]);
});

it('routes 30 edges between 30 boxes in less than 100 ms', () => {
    const boxes = new Map(Array.from({ length: 30 }, (_, i) => [`n${i}`, box((i % 6) * 460, Math.floor(i / 6) * 300, 300, 160)]));
    const edges = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, source: `n${i}`, target: `n${(i * 7 + 3) % 30}`, lane: 0, lanes: 1 }));
    // The best of 3 runs: other test workers share the CPU and can delay one run.
    let best = Infinity, routes = routeEdges(boxes, edges);
    for (let i = 0; i < 3; i++) {
        const start = performance.now();
        routes = routeEdges(boxes, edges);
        best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(100);
    for (const e of edges) {
        const route = routes.get(e.id);
        if (e.source === e.target) continue;
        expect(route, e.id).toBeDefined();
        for (const [p, q] of segments(route!.points)) for (const [id, r] of boxes) if (id !== e.source && id !== e.target) expect(segmentHits(p, q, r), `${e.id} ${id}`).toBe(false);
    }
});

it('the drawn path of a route: rounded corners, the line stops at the arrow base, the label is on the route', () => {
    const route = routeEdges(row, [{ id: 'e', source: 'a', target: 'c', lane: 0, lanes: 1 }]).get('e')!;
    expect(routePath(route.points, 'orthogonal')).toMatch(/Q/);
    expect(routePath(route.points, 'polyline')).not.toMatch(/[QC]/);
    expect(routePath(route.points, 'curved')).toMatch(/Q/);
    const g = edgeGeometry({ source: row.get('a')!, target: row.get('c')!, fromSide: '', toSide: '', lane: 0, lanes: 1, zoom: 1, name: 'x', route, style: 'orthogonal' });
    const end = route.points[route.points.length - 1];
    expect(g.p2).toEqual(end);
    expect(g.path.endsWith(`${end.x},${end.y}`)).toBe(false);
    expect(segments(route.points).some(([p, q]) => Math.abs((q.x - p.x) * (g.mid.y - p.y) - (q.y - p.y) * (g.mid.x - p.x)) < 1e-6
        && g.mid.x >= Math.min(p.x, q.x) && g.mid.x <= Math.max(p.x, q.x) && g.mid.y >= Math.min(p.y, q.y) && g.mid.y <= Math.max(p.y, q.y))).toBe(true);
});

it('segments of different routes do not overlap on the same line (nudge), except the first and last segments at the ports', () => {
    const boxes = new Map(Array.from({ length: 12 }, (_, i) => [`n${i}`, box((i % 2) * 700, Math.floor(i / 2) * 250, 300, 150)]));
    // Every left box to every right box further down: many routes share the corridor between the columns.
    const edges = Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, source: `n${2 * i}`, target: `n${(2 * i + 5) % 12}`, lane: 0, lanes: 1 }));
    const routes = routeEdges(boxes, edges);
    type S = { id: string; a: Pt; b: Pt };
    const middle: S[] = [...routes].flatMap(([id, r]) => segments(r.points).slice(1, -1).map(([a, b]) => ({ id, a, b })));
    const overlap = (s: S, t: S) => s.a.y === s.b.y && t.a.y === t.b.y && s.a.y === t.a.y
        ? Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x)) > Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x))
        : s.a.x === s.b.x && t.a.x === t.b.x && s.a.x === t.a.x
            && Math.min(Math.max(s.a.y, s.b.y), Math.max(t.a.y, t.b.y)) > Math.max(Math.min(s.a.y, s.b.y), Math.min(t.a.y, t.b.y));
    const pairs = middle.flatMap((s, i) => middle.slice(i + 1).filter(t => t.id !== s.id && overlap(s, t)).map(t => `${s.id} ${t.id}`));
    expect(routes.size).toBe(6);
    expect(pairs).toEqual([]);
});
