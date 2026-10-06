import { describe, expect, it } from 'vitest';
import { renderEdge } from '../src/browser/diagram/edge-chrome';
import type { VNode } from 'snabbdom';

describe('return-to-row control', () => {
    it.each([true, false])('renders only when the property can return to a row (%s)', canPutBack => {
        const edge = renderEdge({
            source: { x: 0, y: 0, width: 200, height: 180 },
            target: { x: 450, y: 20, width: 100, height: 26 },
            fromSide: '', toSide: '', lane: 0, lanes: 1, zoom: 1,
            name: 'title', card: '1', elbow: true, color: '', selected: false, hover: false, hidden: false, canPutBack
        });
        const controls = (edge.children as VNode[]).filter(n => n.data?.class?.['row-in']);
        expect(controls).toHaveLength(canPutBack ? 1 : 0);
        if (canPutBack) expect((controls[0].children as VNode[])[0].text).toBe('Show as a row in all containing shapes in this view');
    });
});

describe('"+ target" handle', () => {
    it.each([[true, true, 1], [true, false, 0], [false, true, 0]])('targetHandle %s, selected %s: %s handle', (targetHandle, selected, n) => {
        const edge = renderEdge({
            source: { x: 0, y: 0, width: 200, height: 180 },
            target: { x: 450, y: 20, width: 100, height: 26 },
            fromSide: '', toSide: '', lane: 0, lanes: 1, zoom: 1,
            name: 'title', parts: [{ text: 'title' }], card: '1', elbow: true, color: '', selected, hover: false, hidden: false, targetHandle
        });
        expect((edge.children as VNode[]).filter(c => c.data?.class?.['target-handle'])).toHaveLength(n);
    });
});

describe('edge cardinality', () => {
    it.each([0.25, 0.5, 1, 2])('keeps the badge below a long elbow label at zoom %s', zoom => {
        const edge = renderEdge({
            source: { x: 0, y: 0, width: 200, height: 180 },
            target: { x: 450, y: 20, width: 200, height: 120 },
            fromSide: '', toSide: '', lane: 0, lanes: 1, zoom,
            name: 'sd:namedGraph', parts: [{ text: 'sd:' }, { text: 'namedGraph', color: 'pink' }],
            card: '0..*', elbow: true, color: '', selected: false, hover: false, hidden: false
        });
        const children = edge.children as VNode[];
        const label = children.find(n => n.data?.class?.['edge-label'])!;
        const badge = children.find(n => n.data?.class?.['edge-card'])!;
        const y = Number(/translate\([^,]+,([^)]+)\)/.exec(String(badge.data!.attrs!.transform))![1]);
        const rect = (badge.children as VNode[]).find(n => n.sel === 'rect')!;
        const top = y + Number(rect.data!.attrs!.y);
        const fontSize = Number.parseFloat(String(label.data!.style!.fontSize));
        expect(top).toBeGreaterThan(Number(label.data!.attrs!.y) + fontSize / 2);
    });
});
