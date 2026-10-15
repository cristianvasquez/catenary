import { describe, expect, it } from 'vitest';
import { Doc, ElementKind, ItemFacts, NO_REASON, displayCards, emptyShapes, gestureStep } from '../src';

const doc = (): Doc => {
    const instances = Object.fromEntries(['a', 'b', 'c'].map(id => [id, { id, uri: `urn:${id}`, label: id, types: [], fields: {} }]));
    const shapes = emptyShapes();
    shapes.nodeShapes.s = { id: 's', uri: 'urn:s', label: 'S', targetClass: 'urn:C', file: '', properties: [], constraints: [], raw: [] };
    shapes.valueSets.vs = { id: 'vs', uri: 'urn:vs', label: 'VS', kind: 'scheme', members: [] } as unknown as typeof shapes.valueSets[string];
    return {
        instances, relations: {}, shapes,
        views: {
            v: {
                id: 'v', uri: 'urn:v', label: 'View', edges: [], arrows: [],
                boxes: [
                    { kind: 'card', id: 'pa', element: 'a', x: 10, y: 10, width: 100, height: 50, display: 'simple' },
                    { kind: 'card', id: 'pb', element: 'b', x: 200, y: 10, width: 100, height: 50 },
                    { kind: 'card', id: 'pc', element: 'c', x: 1000, y: 10, width: 100, height: 50 },
                    { kind: 'card', id: 'ps', element: 's', x: 10, y: 100, width: 100, height: 50 },
                    { kind: 'card', id: 'pvs', element: 'vs', x: 200, y: 100, width: 100, height: 50 },
                    { kind: 'group', id: 'g', label: 'G', x: 0, y: 0, width: 400, height: 200 }
                ]
            }
        }
    };
};

const item = (element: string, ...kinds: ElementKind[]): ItemFacts =>
    ({ id: element, element, kinds, types: [], placed: true, placedInActive: true, views: 1, files: 0, unshaped: [] }) as unknown as ItemFacts;

describe('displayCards (Show Details)', () => {
    it('takes the selected instance and node-shape cards, not value sets', () => {
        const out = displayCards(doc(), 'v', [item('a', 'instance'), item('s', 'shape'), item('vs', 'valueSet')]);
        expect(out.map(c => c.element)).toEqual(['a', 's']);
    });
    it('a group gives the instance and node-shape cards inside it', () => {
        const out = displayCards(doc(), 'v', [item('g', 'group')]);
        expect(out.map(c => c.element)).toEqual(['a', 'b', 's']);
        expect(out.map(c => c.display ?? 'detailed')).toEqual(['simple', 'detailed', 'detailed']);
    });
    it('no view or no placed card: none', () => {
        expect(displayCards(doc(), undefined, [item('a', 'instance')])).toEqual([]);
        expect(displayCards(doc(), 'v', [{ ...item('a', 'instance'), placed: false }])).toEqual([]);
    });
});

describe('gestureStep (law_disabledGestureShowsReason)', () => {
    const id = 'catenary.openIn';
    it('no answer yet: run', () => expect(gestureStep(id, undefined)).toEqual({ run: true }));
    it('enabled: run', () => expect(gestureStep(id, [{ id, enabled: true }])).toEqual({ run: true }));
    it('disabled: its reason', () => {
        const reason = 'No file and no view has the element.';
        expect(gestureStep(id, [{ id, enabled: false, reason }])).toEqual({ run: false, message: reason });
    });
    it('disabled with an empty reason: the fallback text', () => {
        expect(gestureStep(id, [{ id, enabled: false }])).toEqual({ run: false, message: NO_REASON });
        expect(gestureStep(id, [{ id, enabled: false, reason: '' }])).toEqual({ run: false, message: NO_REASON });
    });
    it('not in the answer: the action does not apply', () => {
        expect(gestureStep(id, [])).toEqual({ run: false, message: 'Open in… does not apply to the selection.' });
    });
});
