import { expect, it } from 'vitest';
import { FanEdge, Pt, Rect, along, cubicAt, curveAt, curvePath, curveSegments, facingPoint, fanOut, linePath, nearestSegment, port, routeSides } from '../src/browser/diagram/edge-route';

const box = { x: 0, y: 0, width: 200, height: 100 };

it('facingPoint: the side of the box that faces a point', () => {
    expect(facingPoint(box, { x: 500, y: 50 })).toBe('right');
    expect(facingPoint(box, { x: -500, y: 50 })).toBe('left');
    expect(facingPoint(box, { x: 100, y: -300 })).toBe('top');
    expect(facingPoint(box, { x: 100, y: 300 })).toBe('bottom');
});

it('port: on the side, offset from its middle, kept 16 units inside the corners', () => {
    expect(port(box, 'right', 0)).toEqual({ x: 200, y: 50 });
    expect(port(box, 'top', 30)).toEqual({ x: 130, y: 0 });
    expect(port(box, 'top', 500)).toEqual({ x: 184, y: 0 });
    expect(port(box, 'left', -500)).toEqual({ x: 0, y: 16 });
});

it('nearestSegment: a new bend goes after the nearest segment of the polyline', () => {
    const points: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }];
    expect(nearestSegment(points, { x: 50, y: 5 })).toBe(0);
    expect(nearestSegment(points, { x: 95, y: 50 })).toBe(1);
    expect(nearestSegment(points, { x: 150, y: 110 })).toBe(2);
});

it('along: the point at a fraction of the polyline length', () => {
    const points: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(along(points, 0.5)).toEqual({ x: 100, y: 0 });
    expect(along(points, 0.25)).toEqual({ x: 50, y: 0 });
    expect(along(points, 1)).toEqual({ x: 100, y: 100 });
});

it('curveSegments: one cubic per segment, leaving along n1 and entering against n2, through each bend', () => {
    const points: Pt[] = [{ x: 200, y: 50 }, { x: 400, y: 300 }, { x: 600, y: 50 }];
    const segments = curveSegments(points, { x: 1, y: 0 }, { x: -1, y: 0 });
    expect(segments).toHaveLength(2);
    // The first control point is right of the source port (reach 0.4 of the segment, at least 40).
    expect(segments[0].c1.y).toBe(50);
    expect(segments[0].c1.x).toBeGreaterThan(200);
    // The last control point is left of the target end.
    expect(segments[1].c2.y).toBe(50);
    expect(segments[1].c2.x).toBeLessThan(600);
    expect(segments[0].b).toEqual(points[1]);
    expect(segments[1].a).toEqual(points[1]);
    // At the bend the tangent follows the chord of its neighbors: the two control points around it are on one line through it.
    const u = { x: segments[0].c2.x - points[1].x, y: segments[0].c2.y - points[1].y }, v = { x: segments[1].c1.x - points[1].x, y: segments[1].c1.y - points[1].y };
    expect(Math.abs(u.x * v.y - u.y * v.x)).toBeLessThan(1e-6);
    expect(curveAt(segments, 0)).toEqual(points[0]);
    expect(curveAt(segments, 0.5)).toEqual(points[1]);
    expect(curveAt(segments, 1)).toEqual(points[2]);
    expect(cubicAt(segments[0], 0.5).y).toBeGreaterThan(50);
});

it('a short segment keeps its control points at least 40 units out at the ends, at most 500', () => {
    const [s] = curveSegments([{ x: 0, y: 0 }, { x: 20, y: 0 }], { x: 1, y: 0 }, { x: -1, y: 0 });
    expect(s.c1.x).toBe(40);
    const [t] = curveSegments([{ x: 0, y: 0 }, { x: 5000, y: 0 }], { x: 1, y: 0 }, { x: -1, y: 0 });
    expect(t.c1.x).toBe(500);
});

it('paths: direct is straight segments, curved is cubic segments', () => {
    const points: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    expect(linePath(points)).toBe('M0,0 L100,0 L100,100');
    expect(curvePath(curveSegments(points, { x: 1, y: 0 }, { x: 0, y: -1 }))).toMatch(/^M0,0 C[^C]+ C[^C]+100,100$/);
    expect(linePath([])).toBe('');
    expect(curvePath([])).toBe('');
});

it('routeSides: the side the view sets, else the side that faces the first or last bend, else the other box', () => {
    const a = { x: 0, y: 0, width: 200, height: 100 }, b = { x: 600, y: 0, width: 200, height: 100 };
    expect(routeSides(a, b, '', '', [], false)).toEqual({ fromSide: 'right', toSide: 'left' });
    expect(routeSides(a, b, '', '', [{ x: 100, y: 400 }, { x: 700, y: 400 }], false)).toEqual({ fromSide: 'bottom', toSide: 'bottom' });
    expect(routeSides(a, b, 'top', '', [{ x: 700, y: 400 }], false)).toEqual({ fromSide: 'top', toSide: 'bottom' });
    expect(routeSides(a, b, '', 'top', [{ x: 100, y: 400 }], false)).toEqual({ fromSide: 'bottom', toSide: 'top' });
    expect(routeSides(a, a, '', '', [], true)).toEqual({ fromSide: 'top', toSide: 'top' });
});

it('fanOut: the edges of one side of a box take separate ports, in the order of where they go; the pitch stays readable on screen', () => {
    const box = (x: number, y: number) => ({ x, y, width: 200, height: 100 });
    const a = box(0, 0), up = box(600, -300), down = box(600, 300), left = box(-600, 0);
    const edge = (id: string, target: string, targetBox: Rect): FanEdge => ({ id, source: 'a', target, sourceBox: a, targetBox, fromSide: '', toSide: '', vertices: [], name: id });
    const offsets = fanOut([edge('e-down', 'down', down), edge('e-up', 'up', up), edge('e-left', 'left', left)], 1);
    // Two edges leave the right side: the one to the upper box above the one to the lower box, 48 units apart.
    expect(offsets.get('e-up')!.from).toBe(-24);
    expect(offsets.get('e-down')!.from).toBe(24);
    // The only edge of the left side, and the only edge into each target: in the middle.
    expect(offsets.get('e-left')!.from).toBe(0);
    expect(offsets.get('e-up')!.to).toBe(0);
    // Zoomed out, the pitch grows so that it stays 48 px on screen.
    expect(fanOut([edge('e-down', 'down', down), edge('e-up', 'up', up)], 0.5).get('e-down')!.from).toBe(48);
    // A top side reserves the width of the longest label.
    const top = fanOut([{ ...edge('x', 'up', box(0, -400)), name: 'a-long-property-name' }, edge('y', 'up2', box(100, -400))], 1);
    expect(Math.abs(top.get('x')!.from - top.get('y')!.from)).toBeGreaterThan(48);
    // A self edge without bends keeps its arch ports: it takes no port of the group.
    expect(fanOut([{ ...edge('s', 'a', a) }], 1).size).toBe(0);
});
