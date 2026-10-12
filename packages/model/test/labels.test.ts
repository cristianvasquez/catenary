// The one label rule (spec/manifest.hs §6.2 pickLabel): the literals of the first label predicate that has any; of them, the
// workspace language, else a literal without a language, else the smallest.

import { describe, expect, it } from 'vitest';
import { pickLabel } from '../src/labels';

const CONCEPT = [{ value: 'arkaluonteinen', language: 'fi' }, { value: 'känslig', language: 'sv' }, { value: 'sensitive', language: 'en-GB' }];

describe('pickLabel', () => {
    it('takes the literal with the exact tag, case-insensitive', () => {
        expect(pickLabel([CONCEPT], 'sv')).toBe('känslig');
        expect(pickLabel([CONCEPT], 'SV')).toBe('känslig');
    });

    it('takes a subtag: en matches en-GB', () => {
        expect(pickLabel([CONCEPT], 'en')).toBe('sensitive');
        expect(pickLabel([[{ value: 'english', language: 'english' }]], 'en')).toBe('english');
        expect(pickLabel([[{ value: 'b', language: 'english' }, { value: 'c' }]], 'en')).toBe('c');
    });

    it('without a match: the literal without a language', () => {
        expect(pickLabel([[...CONCEPT, { value: 'zz plain' }]], 'de')).toBe('zz plain');
        expect(pickLabel([[...CONCEPT, { value: 'zz plain', language: '' }]], 'de')).toBe('zz plain');
    });

    it('without a match and without a plain literal: the smallest', () => {
        expect(pickLabel([CONCEPT], 'de')).toBe('arkaluonteinen');
        expect(pickLabel([[{ value: 'b', language: 'fi' }, { value: 'A', language: 'sl' }]], 'de')).toBe('A');
    });

    it('an empty setting: the plain literal, else the smallest', () => {
        for (const language of [undefined, '', '  ']) {
            expect(pickLabel([CONCEPT], language)).toBe('arkaluonteinen');
            expect(pickLabel([[...CONCEPT, { value: 'zz plain' }]], language)).toBe('zz plain');
        }
    });

    it('the first predicate with a literal gives the candidates; none: undefined', () => {
        expect(pickLabel([[], CONCEPT, [{ value: 'name' }]], 'sv')).toBe('känslig');
        expect(pickLabel([[{ value: 'label', language: 'fi' }], CONCEPT], 'sv')).toBe('label');
        expect(pickLabel([[], []], 'sv')).toBeUndefined();
        expect(pickLabel([], 'sv')).toBeUndefined();
    });
});
