import { describe, expect, it } from 'vitest';
import { layoutPastedBoxes } from '../src/paste-layout';

describe('layout of arriving placements', () => {
    it('packs many variable-size boxes without overlapping fixed placements', () => {
        const fixed = [{ x: 0, y: 0, width: 500, height: 300 }, { x: 600, y: 300, width: 200, height: 100 }];
        const saved = structuredClone(fixed);
        const added = Array.from({ length: 30 }, (_, i) => ({ id: String(i), x: 0, y: 0, width: 100 + i * 9, height: 60 + i * 5 }));
        const result = layoutPastedBoxes(added, fixed, { x: 0, y: 0 });
        const all = [...fixed, ...result];
        for (const b of result) for (const other of all) if (other !== b) {
            expect(b.x + b.width <= other.x || other.x + other.width <= b.x || b.y + b.height <= other.y || other.y + other.height <= b.y).toBe(true);
        }
        expect(fixed).toEqual(saved);
    });

    it('moves copied nested frames and their contents as one block', () => {
        const added = [
            { id: 'outer', group: true, x: 0, y: 0, width: 500, height: 500 },
            { id: 'inner', group: true, x: 20, y: 30, width: 300, height: 300 },
            { id: 'card', x: 40, y: 60, width: 100, height: 100 }
        ];
        const result = layoutPastedBoxes(added, [{ x: 0, y: 0, width: 500, height: 500 }], { x: 0, y: 0 });
        expect(result.map((b, i) => [b.x - added[i].x, b.y - added[i].y])).toEqual([[560, 0], [560, 0], [560, 0]]);
    });

    it('keeps a card in its frame when its drawn content extends past the frame border', () => {
        const frame = { id: 'frame', group: true, x: 0, y: 0, width: 200, height: 200 };
        const card = { id: 'card', x: 20, y: 20, width: 400, height: 400, membership: { x: 20, y: 20, width: 100, height: 100 } };
        const other = { id: 'other', x: 1000, y: 0, width: 100, height: 100 };
        const result = layoutPastedBoxes([frame, card, other], [], { x: 10, y: 10 });
        expect(result.find(b => b.id === 'card')).toMatchObject({ x: 30, y: 30 });
        const placedOther = result.find(b => b.id === 'other')!;
        expect(placedOther.x >= 490 || placedOther.y >= 490).toBe(true);
        expect(result.find(b => b.id === 'frame')).toMatchObject({ width: 200, height: 200 });
    });
});
