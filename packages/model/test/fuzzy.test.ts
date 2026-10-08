import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from '../src/fuzzy';

describe('fuzzyMatch', () => {
    it('matches ordered characters with gaps and highlights their positions', () => {
        expect(fuzzyMatch('Model Explorer', 'mdex')?.indices).toEqual([0, 2, 6, 7]);
        expect(fuzzyMatch('Model Explorer', 'xm')).toBeUndefined();
        expect(fuzzyMatch('Model Explorer', '')?.indices).toEqual([]);
    });
    it('favors consecutive characters and word starts', () => {
        expect(fuzzyMatch('ab', 'ab')!.score).toBeGreaterThan(fuzzyMatch('axb', 'ab')!.score);
        expect(fuzzyMatch('Alpha Beta', 'ab')!.score).toBeGreaterThan(fuzzyMatch('xxalphabeta', 'ab')!.score);
        expect(fuzzyMatch('ModelExplorer', 'me')?.indices).toEqual([0, 5]);
    });
});
