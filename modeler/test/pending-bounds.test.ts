import { describe, expect, it } from 'vitest';
import { Bounds, PendingBoundsState, TIMEOUT } from '../src/browser/diagram/pending-bounds-state';

// A server model sent before the server applied the last drop must not draw the box at its older place (fast consecutive drags).

const root = (revision: number | undefined, bounds: Bounds) => {
    const card = { bounds: { ...bounds } };
    return { revision, card, index: { getById: (id: string) => (id === 'card' ? card : undefined) } };
};
const at = (x: number, y: number): Bounds => ({ x, y, width: 100, height: 50 });

describe('pending bounds', () => {
    it('a server model with an older drop shows the last drop; the model with the last drop confirms all', () => {
        const s = new PendingBoundsState();
        s.sent.set('card', { bounds: [at(10, 0), at(20, 0)], at: 0 });
        const first = root(1, at(10, 0));
        s.apply(first, 10);
        expect(first.card.bounds).toEqual(at(20, 0));
        expect(s.sent.get('card')?.bounds).toEqual([at(20, 0)]);
        const second = root(2, at(20, 0));
        s.apply(second, 20);
        expect(second.card.bounds).toEqual(at(20, 0));
        expect(s.sent.has('card')).toBe(false);
        // Later server models (an undo, another window) are drawn as they are.
        const undo = root(3, at(10, 0));
        s.apply(undo, 30);
        expect(undo.card.bounds).toEqual(at(10, 0));
    });

    it('a model from before the first drop confirms nothing; the same revision again is not a server model', () => {
        const s = new PendingBoundsState();
        s.revision = 4;
        s.sent.set('card', { bounds: [at(10, 0)], at: 0 });
        const stale = root(5, at(0, 0));
        s.apply(stale, 1);
        expect(stale.card.bounds).toEqual(at(10, 0));
        const local = root(5, at(10, 0));
        s.apply(local, 2);
        expect(s.sent.get('card')?.bounds).toEqual([at(10, 0)]);
    });

    it('the server rounds positions; an unconfirmed drop gives way after the timeout; a removed box is forgotten', () => {
        const s = new PendingBoundsState();
        s.sent.set('card', { bounds: [at(10.4, 0.6)], at: 0 });
        s.apply(root(1, at(10, 1)), 1);
        expect(s.sent.has('card')).toBe(false);
        s.sent.set('card', { bounds: [at(50, 0)], at: 0 });
        const late = root(2, at(0, 0));
        s.apply(late, TIMEOUT + 1);
        expect(late.card.bounds).toEqual(at(0, 0));
        expect(s.sent.has('card')).toBe(false);
        s.sent.set('gone', { bounds: [at(1, 1)], at: 0 });
        s.apply(root(3, at(0, 0)), 1);
        expect(s.sent.has('gone')).toBe(false);
    });
    // Current behavior (MOVE1, spec/open.md): after the confirmation the entry is gone, so a later server model with the old bounds is drawn as it is.
    // The backend no longer sends a queued refresh model older than the confirmation (ui-manifest §3.2 law_clientGetsNoOlderModel). A later
    // model with the old bounds can still come from another change, for example an undo.
    it('confirm, then stale model: the stale model draws the old bounds', () => {
        const s = new PendingBoundsState();
        s.revision = 1;
        s.sent.set('card', { bounds: [at(20, 0)], at: 0 });
        const confirm = root(2, at(20, 0));
        s.apply(confirm, 10);
        expect(confirm.card.bounds).toEqual(at(20, 0));
        expect(s.sent.has('card')).toBe(false);
        const stale = root(3, at(0, 0));
        s.apply(stale, 20);
        expect(stale.card.bounds).toEqual(at(0, 0));
        expect(s.sent.has('card')).toBe(false);
        expect(s.revision).toBe(3);
    });

    // Current behavior: the same revision again is not a server model and changes no state. The entry is already gone, so `apply`
    // does not put B1 back: the root is drawn with the bounds it holds.
    it('confirm, then a model at the same revision: not a server model, the state stays as after the confirmation', () => {
        const s = new PendingBoundsState();
        s.revision = 1;
        s.sent.set('card', { bounds: [at(20, 0)], at: 0 });
        s.apply(root(2, at(20, 0)), 10);
        const same = root(2, at(0, 0));
        s.apply(same, 20);
        expect(s.revision).toBe(2);
        expect(s.sent.has('card')).toBe(false);
        expect(same.card.bounds).toEqual(at(0, 0));
    });
});
