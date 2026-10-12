import { describe, expect, it } from 'vitest';
import { VIEW_CLIP_FORMAT } from '@catenary/model';
import { VIEW_CLIP_WEB_TYPE, clipFormOf, clipIdOf, clipToken, rdfOf } from '../src/browser/diagram/clip-transport';

// The clip forms of the system clipboard (spec/ui-manifest.hs §5.8, law_pasteOrder).

const clipboard = (data: Record<string, string>) => [Object.keys(data), (type: string) => data[type] ?? ''] as const;
const ttl = '<urn:a> a <urn:Person> .';

describe('clip transport', () => {
    it('law_pasteOrder: the custom type before a text/plain token before RDF', () => {
        expect(clipIdOf(...clipboard({ [VIEW_CLIP_WEB_TYPE]: clipToken('c1'), 'text/plain': clipToken('c2') }))).toBe('c1');
        expect(clipIdOf(...clipboard({ [VIEW_CLIP_FORMAT]: clipToken('c1'), 'text/plain': ttl }))).toBe('c1');
        expect(clipIdOf(...clipboard({ 'text/plain': clipToken('c2') }))).toBe('c2');
        expect(clipFormOf(...clipboard({ [VIEW_CLIP_WEB_TYPE]: clipToken('c1'), 'text/plain': ttl }))).toBe('token');
        expect(clipFormOf(...clipboard({ 'text/plain': clipToken('c2') }))).toBe('token');
        expect(clipFormOf(...clipboard({ 'text/plain': ttl }))).toBe('rdf');
        expect(clipFormOf(...clipboard({ 'text/plain': ' ' }))).toBe('none');
        expect(clipFormOf(...clipboard({}))).toBe('none');
    });

    it('a JSON object with more keys than clipboardId is RDF, not a token', () => {
        const jsonld = JSON.stringify({ '@id': 'urn:a', clipboardId: 'c1' });
        expect(clipFormOf(...clipboard({ 'text/plain': jsonld }))).toBe('rdf');
        expect(clipFormOf(...clipboard({ [VIEW_CLIP_WEB_TYPE]: 'not a token', 'text/plain': ttl }))).toBe('rdf');
    });

    it('RDF reads an RDF media type before text/plain', () => {
        expect(rdfOf(...clipboard({ 'application/trig': '<urn:g> {}', 'text/plain': ttl }))).toEqual({ text: '<urn:g> {}', mediaType: 'application/trig' });
        expect(rdfOf(...clipboard({ 'text/plain': ttl }))).toEqual({ text: ttl, mediaType: undefined });
    });
});
