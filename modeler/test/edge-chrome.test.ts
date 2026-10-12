import { describe, expect, it } from 'vitest';
import { edgeGeometry, logicCenter, renderEdge } from '../src/browser/diagram/edge-chrome';
import type { VNode } from 'snabbdom';

const source = { x: 0, y: 0, width: 200, height: 180 };
const target = { x: 450, y: 20, width: 200, height: 120 };
const props = {
    source, target, fromSide: '' as const, toSide: '' as const, lane: 0, lanes: 1, zoom: 1,
    name: 'prov:qualifiedAttribution', parts: [{ text: 'prov:qualifiedAttribution' }],
    color: '', selected: false, hover: false, hidden: false
};
const children = (edge: VNode) => edge.children as VNode[];
const translateY = (n: VNode) => Number(/translate\([^,]+,([^)]+)\)/.exec(String(n.data!.attrs!.transform))![1]);

describe('route (UI §7.4)', () => {
    it('keeps generated edge details in an SVG tooltip, not the label', () => {
        const details = 'sh:node: Book shape\nSource: Shop\nPath: ex:stocks';
        const edge = renderEdge({ ...props, parts: undefined, targeting: true, name: 'sh:node', details });
        expect(children(edge).find(n => n.sel === 'title')?.text).toBe(details);
        expect(children(edge).find(n => n.data?.class?.['edge-label'])?.text).toBe('sh:node');
    });

    it('without bends: a curve between the facing sides, the label at its middle, the line stops at the arrow base', () => {
        const g = edgeGeometry(props);
        expect(g.p1).toEqual({ x: 200, y: 90 });
        expect(g.p2).toEqual({ x: 450, y: 80 });
        expect(g.path).toMatch(/^M200,90 C/);
        expect(g.path.endsWith('450,80')).toBe(false);
        expect(g.label.x).toBeCloseTo((g.p1.x + g.p2.x - 9.6) / 2);
        expect(g.points).toHaveLength(2);
    });

    it('port offsets of the side fan-out replace the lane offset', () => {
        const g = edgeGeometry({ ...props, offsets: { from: -30, to: 20 } });
        expect(g.p1).toEqual({ x: 200, y: 60 });
        expect(g.p2).toEqual({ x: 450, y: 100 });
    });

    it('direct: straight segments through the bends', () => {
        const vertices = [{ x: 300, y: 400 }];
        const g = edgeGeometry({ ...props, vertices, style: 'direct' });
        expect(g.path).toBe(`M${g.p1.x},${g.p1.y} L300,400 L${g.points[2].x},${g.points[2].y}`);
    });

    it('a bend decides the side of each end and the curve goes through it', () => {
        const vertices = [{ x: 100, y: -300 }, { x: 550, y: -300 }];
        const g = edgeGeometry({ ...props, vertices });
        expect(g.p1.y).toBe(source.y);                 // out of the top: the first bend is above the source
        expect(g.p2.y).toBe(target.y);                 // into the top of the target: the last bend is above it
        expect(g.points.slice(1, 3)).toEqual(vertices);
        expect(g.path).toContain('100,-300');
        expect(g.path).toContain('550,-300');
        // A side that the view sets wins over the bend.
        expect(edgeGeometry({ ...props, vertices, fromSide: 'right' }).p1).toEqual({ x: 200, y: 90 });
    });

    it('the label is at the middle of the route, between two equal bends on the first bend', () => {
        const g = edgeGeometry({ ...props, vertices: [{ x: 325, y: 400 }] });
        expect(g.label.y).toBeGreaterThan(200);
        expect(Math.abs(g.label.x - 325)).toBeLessThan(20);
    });

    it('a self edge without bends is an arch above the top side; a bend makes it an ordinary route', () => {
        const a = edgeGeometry({ ...props, target: source, self: true });
        expect(a.p1.y).toBe(0);
        expect(a.p2.y).toBe(0);
        expect(a.p1.x).toBeGreaterThan(a.p2.x);
        expect(a.label.y).toBeLessThan(-64);
        expect(a.label.x).toBeCloseTo(100);
        expect(a.tail.y).toBeLessThan(0);
        const b = edgeGeometry({ ...props, target: source, self: true, vertices: [{ x: 400, y: 90 }] });
        expect(b.points).toHaveLength(3);
        expect(b.p1.x).toBe(200);                      // both ends on the right side, apart
        expect(b.p2.x).toBe(200);
        expect(b.p1.y - b.p2.y).toBeGreaterThanOrEqual(80);
    });
});

describe('lanes (UI §7.4 directLanePitch, selfLoopClearance)', () => {
    const far = { x: 650, y: 0, width: 200, height: 180 };
    const base = { source, target: far, fromSide: '' as const, toSide: '' as const, lane: 0, lanes: 2, name: 'dprod:outputDataset' };
    it.each([0.25, 0.5, 1, 2])('separates opposing labels at zoom %s', zoom => {
        const a = edgeGeometry({ ...base, zoom });
        const b = edgeGeometry({ ...base, source: far, target: source, lane: 1, zoom });
        expect(Math.abs(a.label.y - b.label.y) * zoom).toBeGreaterThanOrEqual(48);
        expect(a.p1.y).toBeGreaterThanOrEqual(source.y);
        expect(a.p1.y).toBeLessThanOrEqual(source.y + source.height);
    });
    it.each([0.25, 1, 2])('separates vertical labels by their estimated widths at zoom %s', zoom => {
        const below = { ...source, y: 650 };
        const a = edgeGeometry({ ...base, target: below, zoom });
        const b = edgeGeometry({ ...base, target: below, lane: 1, zoom });
        const width = base.name.length * Math.max(18, 11 / zoom) * 0.65;
        expect(Math.abs(a.label.x - b.label.x)).toBeGreaterThanOrEqual(width + 24 / zoom - 0.001);
    });
    it.each([0.25, 1, 2])('gives parallel self edges separate arch heights at zoom %s', zoom => {
        const a = edgeGeometry({ ...base, target: source, self: true, zoom });
        const b = edgeGeometry({ ...base, target: source, self: true, lane: 1, zoom });
        expect(source.y - a.label.y).toBeGreaterThanOrEqual(64 / zoom * 0.75);
        expect((a.label.y - b.label.y) * zoom).toBeGreaterThanOrEqual(36);
    });
});

describe('logical constraint circle', () => {
    it('sits below the lowest member label, right of their middle; one member: above its label', () => {
        expect(logicCenter([{ x: 100, y: 100 }, { x: 140, y: 140 }], 1)).toEqual({ x: 144, y: 168 });
        expect(logicCenter([{ x: 100, y: 100 }], 1)).toEqual({ x: 100, y: 64 });
        expect(logicCenter([{ x: 100, y: 100 }, { x: 140, y: 140 }], 1, [{ x: 144, y: 168 }])!.y).toBeGreaterThan(168);
    });
});

describe('controls', () => {
    it('bend handles show on hover or selection, one per bend, with its index', () => {
        const vertices = [{ x: 300, y: 400 }, { x: 350, y: 420 }];
        const handles = (edge: VNode) => children(edge).filter(n => n.data?.class?.['edge-vertex']);
        expect(handles(renderEdge({ ...props, vertices }))).toHaveLength(0);
        const shown = handles(renderEdge({ ...props, vertices, hover: true }));
        expect(shown).toHaveLength(2);
        expect(shown.map(h => h.data!.attrs!['data-vertex'])).toEqual([0, 1]);
        expect(shown[1].data!.attrs!.cx).toBe(350);
        expect(handles(renderEdge({ ...props, vertices, selected: true }))).toHaveLength(2);
        expect(handles(renderEdge({ ...props, vertices, selected: true, arrow: true }))).toHaveLength(0);
    });

    it('keeps the logic handle above the label and away from controls below the edge', () => {
        const edge = renderEdge({ ...props, selected: true, logicHandle: true, canPutBack: true, card: '1' });
        const label = children(edge).find(n => n.data?.class?.['edge-label'])!;
        const handle = children(edge).find(n => n.data?.class?.['logic-handle'])!;
        const fontSize = Number.parseFloat(String(label.data!.style!.fontSize));
        expect(translateY(handle) + 8).toBeLessThan(Number(label.data!.attrs!.y) - fontSize / 2);
    });

    it.each([true, false])('renders the return-to-row control only when the property can return to a row (%s)', canPutBack => {
        const edge = renderEdge({ ...props, target: { x: 450, y: 20, width: 100, height: 26 }, parts: undefined, name: 'title', card: '1', canPutBack });
        const controls = children(edge).filter(n => n.data?.class?.['row-in']);
        expect(controls).toHaveLength(canPutBack ? 1 : 0);
        if (canPutBack) expect((controls[0].children as VNode[])[0].text).toBe('Show as a row in all containing shapes in this view');
    });

    it.each([[true, true, 1], [true, false, 0], [false, true, 0]])('targetHandle %s, selected %s: %s handle', (targetHandle, selected, n) => {
        const edge = renderEdge({ ...props, name: 'title', parts: [{ text: 'title' }], card: '1', selected, targetHandle });
        expect(children(edge).filter(c => c.data?.class?.['target-handle'])).toHaveLength(n);
    });

    it.each([0.25, 0.5, 1, 2])('keeps the cardinality badge below the label and near the target at zoom %s', zoom => {
        const edge = renderEdge({ ...props, zoom, name: 'sd:namedGraph', parts: [{ text: 'sd:' }, { text: 'namedGraph', color: 'pink' }], card: '0..*' });
        const label = children(edge).find(n => n.data?.class?.['edge-label'])!;
        const badge = children(edge).find(n => n.data?.class?.['edge-card'])!;
        const rect = (badge.children as VNode[]).find(n => n.sel === 'rect')!;
        const top = translateY(badge) + Number(rect.data!.attrs!.y);
        const fontSize = Number.parseFloat(String(label.data!.style!.fontSize));
        expect(top).toBeGreaterThan(Number(label.data!.attrs!.y) + fontSize / 2);
        const x = Number(/translate\(([^,]+),/.exec(String(badge.data!.attrs!.transform))![1]);
        expect(x).toBeGreaterThanOrEqual(Number(label.data!.attrs!.x));
        expect(x).toBeLessThan(target.x);
    });
});
