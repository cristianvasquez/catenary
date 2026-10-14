import { describe, expect, it, vi } from 'vitest';
import type { VNode } from 'snabbdom';

// The GLSP export command: a copy of the root at zoom 1 (request-export-command.js).
vi.mock('@eclipse-glsp/client', () => ({
    TYPES: { Action: Symbol('Action') },
    isViewport: (root: object) => 'zoom' in root,
    RequestExportCommand: class {
        constructor(readonly action: unknown) { }
        execute(context: { root: object }) { return { model: { ...context.root, zoom: 1 }, modelChanged: true }; }
    }
}));

import { CanvasZoomExportCommand, ZoomedRoot, sizeZoom } from '../src/browser/diagram/export-zoom';
import { renderEdge, renderLogic } from '../src/browser/diagram/edge-chrome';

const props = {
    source: { x: 0, y: 0, width: 200, height: 180 }, target: { x: 450, y: 20, width: 200, height: 120 }, fromSide: '' as const, toSide: '' as const,
    lane: 0, lanes: 1, name: 'ex:knows', color: '', selected: false, hover: false, hidden: false, card: '0..*'
};
const label = (edge: VNode) => (edge.children as VNode[]).find(n => n.data?.class?.['edge-label'])!;
const badge = (edge: VNode) => ((edge.children as VNode[]).find(n => n.data?.attrs?.['data-card'])!.children as VNode[]).find(n => n.sel === 'text')!;

describe('export zoom (UI §9.2 law_exportSizesUseCanvasZoom)', () => {
    it('the export root keeps zoom 1 for the geometry and gets the zoom of the live canvas', () => {
        const command = new CanvasZoomExportCommand({ kind: 'requestExport' } as never);
        const result = command.execute({ root: { zoom: 0.3 } } as never);
        expect((result.model as ZoomedRoot).zoom).toBe(1);
        expect((result.model as ZoomedRoot).canvasZoom).toBe(0.3);
        expect(sizeZoom(result.model as ZoomedRoot)).toBe(0.3);
    });

    it('a live root uses its own zoom; no zoom is 1', () => {
        expect(sizeZoom({ zoom: 0.5 })).toBe(0.5);
        expect(sizeZoom({})).toBe(1);
        expect(sizeZoom({ zoom: 0 })).toBe(1);
    });

    it.each([0.3, 0.5, 1, 2])('at canvas zoom %s: label font max(18, 11 / z), halo 0.4 of it, badge text 12 / z', z => {
        const edge = renderEdge({ ...props, zoom: sizeZoom({ zoom: 1, canvasZoom: z }) });
        const font = Math.max(18, 11 / z);
        expect(parseFloat(label(edge).data!.style!.fontSize as string)).toBeCloseTo(font);
        expect(parseFloat(label(edge).data!.style!.strokeWidth as string)).toBeCloseTo(font * 0.4);
        expect(parseFloat(badge(edge).data!.style!.fontSize as string)).toBeCloseTo(12 / z);
    });

    it.each([0.3, 1])('at canvas zoom %s: operator text 13 / z', z => {
        const logic = renderLogic({ mids: [{ x: 0, y: 0 }], center: { x: 0, y: -40 }, operator: 'or', zoom: sizeZoom({ zoom: 1, canvasZoom: z }), selected: false, hover: false });
        const text = (logic.children as VNode[]).find(n => n.sel === 'text')!;
        expect(parseFloat(text.data!.style!.fontSize as string)).toBeCloseTo(13 / z);
    });
});
