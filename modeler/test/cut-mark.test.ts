import { describe, expect, it, vi } from 'vitest';
import { VIEW_CLIP_FORMAT } from '@catenary/model';
import { CutMark, MarkEvent, NO_MARK, asCopyClip, cutMessage, markAfter, pasteMessage } from '../src/browser/diagram/cut-mark';

// The cut mark (spec/ui-manifest.hs §5.8): window state with no command and no undo step.

const marked = markAfter(NO_MARK, { kind: 'cut', view: 'v', ids: ['a', 'b'], clipboardId: 'c1' });

describe('cut mark', () => {
    it('a cut sets the mark; a second cut replaces it', () => {
        expect(marked).toEqual({ view: 'v', ids: new Set(['a', 'b']), clipboardId: 'c1' });
        expect(markAfter(marked, { kind: 'cut', view: 'w', ids: ['x'], clipboardId: 'c2' })).toEqual({ view: 'w', ids: new Set(['x']), clipboardId: 'c2' });
    });

    it('law_markClearsOnEvents: copy, Escape, window close, a move and "Already in this view" clear it; undo and a refused paste keep it', () => {
        const clears: MarkEvent[] = [{ kind: 'copy' }, { kind: 'escape' }, { kind: 'close' }, { kind: 'paste', outcome: 'moved' }, { kind: 'paste', outcome: 'alreadyInView' }];
        for (const e of clears) expect(markAfter(marked, e), e.kind).toEqual(NO_MARK);
        expect(markAfter(marked, { kind: 'undo' })).toBe(marked);
        expect(markAfter(marked, { kind: 'paste', outcome: 'refused' })).toBe(marked);
    });

    it('the window mark fires once for each change, with the mark before it, and dims only in its view', () => {
        const mark = new CutMark();
        const seen = vi.fn();
        mark.onDidChange(seen);
        mark.clear();
        expect(seen).not.toHaveBeenCalled();
        mark.set('v', ['a'], 'c1');
        expect(mark.has('v', 'a')).toBe(true);
        expect(mark.has('w', 'a')).toBe(false);
        expect(mark.has(undefined, 'a')).toBe(false);
        mark.apply({ kind: 'undo' });
        expect(seen).toHaveBeenCalledTimes(1);
        mark.clear();
        expect(seen).toHaveBeenCalledTimes(2);
        expect(seen.mock.calls[1][0]).toMatchObject({ view: 'v' });
        expect(mark.marked).toBe(false);
    });

    it('a canceled cut keeps its clip as a copy: a later paste places and does not move', () => {
        const data = { format: VIEW_CLIP_FORMAT, [VIEW_CLIP_FORMAT]: JSON.stringify({ mode: 'cut', source: 'urn:v', boxes: [], edges: [] }), clipboardId: 'c1' };
        const copy = asCopyClip(data);
        expect(JSON.parse(copy[VIEW_CLIP_FORMAT])).toEqual({ mode: 'copy', source: 'urn:v', boxes: [], edges: [] });
        expect(copy.clipboardId).toBe('c1');
        expect(asCopyClip({ format: 'x' })).toEqual({ format: 'x' });
    });

    it('messages: exact text, singular for one element, zero counts left out', () => {
        expect(cutMessage(3)).toBe('3 elements cut. Paste moves them. Escape cancels.');
        expect(cutMessage(1)).toBe('1 element cut. Paste moves it. Escape cancels.');
        expect(pasteMessage(3, 0, 0)).toBe('Placed 3.');
        expect(pasteMessage(3, 2, 1)).toBe('Placed 3. Skipped 2 already in this view. 1 missing from this model.');
        expect(pasteMessage(1, 0, 2)).toBe('Placed 1. 2 missing from this model.');
    });
});
