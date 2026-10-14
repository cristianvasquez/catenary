import { expect, it } from 'vitest';
import { pathParts } from '@catenary/model';
import { vocabularyParts } from '../src/browser/diagram/vocabulary-color';

const DCT = 'http://purl.org/dc/terms/';
const path = pathParts({ kind: 'sequence', items: [{ kind: 'iri', iri: DCT + 'type' }, { kind: 'iri', iri: 'urn:p' }] } as never);
const drawn = (mode: 'name' | 'prefix' | 'off') => vocabularyParts(path, mode).map(x => [x.text, x.color ? 'color' : x.muted ? 'muted' : 'plain']);

it('colors one part of prefix:local, keeps operators muted and an IRI without prefix colored (UI §7.2 law_oneColoredPart)', () => {
    expect(path.map(x => x.text)).toEqual(['dct:', 'type', '/', '<urn:p>']);
    expect(drawn('name')).toEqual([['dct:', 'muted'], ['type', 'color'], ['/', 'muted'], ['<urn:p>', 'color']]);
    expect(drawn('prefix')).toEqual([['dct:', 'color'], ['type', 'plain'], ['/', 'muted'], ['<urn:p>', 'color']]);
    expect(drawn('off')).toEqual([['dct:', 'muted'], ['type', 'plain'], ['/', 'muted'], ['<urn:p>', 'plain']]);
    expect(vocabularyParts(path, 'prefix')[0].color).toBe(path[1].color);
});

it('urn:name: is a prefix that is not drawn: name colors the name, prefix and off draw it plain (UI §7.2)', () => {
    const named = pathParts({ kind: 'iri', iri: 'urn:name:reads' } as never);
    const show = (mode: 'name' | 'prefix' | 'off') => vocabularyParts(named, mode).map(x => [x.text, x.color ? 'color' : x.muted ? 'muted' : 'plain']);
    expect(show('name')).toEqual([['reads', 'color']]);
    expect(show('prefix')).toEqual([['reads', 'plain']]);
    expect(show('off')).toEqual([['reads', 'plain']]);
});
