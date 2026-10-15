// filterHits (search.ts): the filter of `rpc search`, spec/manifest.hs §11.1.

import { describe, expect, it } from 'vitest';
import { iriId } from '../src/ids';
import { SEARCH_FILTER_KEYS, SearchFilter, SearchHit, filterHits } from '../src/search';

const V = 'urn:v:main';
const hit = (iri: string, label: string, kind: SearchHit['kind'] = 'instance', types: string[] = [], views: string[] = []): SearchHit =>
    ({ id: iriId(iri), iri, label, kind, types, views });
const HITS: SearchHit[] = [
    hit('urn:x:a', 'Alpha', 'instance', ['urn:c:Robot'], [iriId(V)]),
    hit('urn:skolem:b1', 'Anonymous', 'instance', ['urn:c:Robot'], [iriId(V)]),
    hit('urn:x:b', 'Beta', 'shape', ['http://www.w3.org/ns/shacl#NodeShape']),
    hit('urn:x:robot-c', 'Gamma', 'instance', ['urn:c:Thing']),
    hit(V, 'Main view', 'view', ['urn:view:View'])
];
const labels = (f: SearchFilter) => filterHits(HITS, f).map(h => h.label);

describe('filterHits', () => {
    it('text: a case-insensitive substring of the label, the IRI or a type', () => {
        expect(labels({ text: 'alp' })).toEqual(['Alpha']);
        expect(labels({ text: 'ROBOT' })).toEqual(['Alpha', 'Gamma']);
        expect(labels({ text: 'nodeshape' })).toEqual(['Beta']);
        expect(labels({ text: '' })).toEqual(['Alpha', 'Beta', 'Gamma', 'Main view']);
    });

    it('kind, type, view (id or IRI) and limit', () => {
        expect(labels({ kind: 'shape' })).toEqual(['Beta']);
        expect(labels({ type: 'urn:c:Robot' })).toEqual(['Alpha']);
        expect(labels({ type: 'urn:c:Rob' })).toEqual([]);
        expect(labels({ view: iriId(V) })).toEqual(['Alpha']);
        expect(labels({ view: V })).toEqual(['Alpha']);
        expect(labels({ limit: 2 })).toEqual(['Alpha', 'Beta']);
        expect(labels({ limit: 0 })).toEqual([]);
        expect(labels({ kind: 'instance', text: 'a', limit: 1 })).toEqual(['Alpha']);
    });

    it('urn:skolem: hits only with skolem: true', () => {
        expect(labels({})).not.toContain('Anonymous');
        expect(labels({ skolem: true })).toEqual(HITS.map(h => h.label));
        expect(labels({ skolem: true, view: V })).toEqual(['Alpha', 'Anonymous']);
    });

    it('law_searchFilterSubset: the result is a subsequence of the hits', () => {
        const filters: SearchFilter[] = [{}, { skolem: true }, { text: 'a' }, { kind: 'instance', skolem: true }, { view: V, limit: 1 }, { type: 'urn:c:Thing' }];
        for (const f of filters) {
            const out = filterHits(HITS, f);
            let i = 0;
            for (const h of out) { while (i < HITS.length && HITS[i] !== h) i++; expect(i, JSON.stringify(f)).toBeLessThan(HITS.length); i++; }
        }
    });

    it('law_searchUnknownKeyFails: an unknown key throws and names every valid key', () => {
        expect(SEARCH_FILTER_KEYS).toEqual(['text', 'kind', 'type', 'view', 'limit', 'skolem']);
        for (const f of [{ name: 'x' }, { text: 'a', views: 'v' }, { Text: 'a' }]) {
            expect(() => filterHits(HITS, f as SearchFilter)).toThrow(/unknown filter key/);
            try { filterHits(HITS, f as SearchFilter); } catch (e) { for (const k of SEARCH_FILTER_KEYS) expect(String(e)).toContain(k); }
        }
    });

    it('a wrong value or a filter that is not an object throws', () => {
        for (const f of [null, [], 'robot', { kind: 'thing' }, { limit: -1 }, { limit: 1.5 }, { text: 3 }, { skolem: 'yes' }]) {
            expect(() => filterHits(HITS, f as unknown as SearchFilter), JSON.stringify(f)).toThrow(/^search: /);
        }
    });
});
