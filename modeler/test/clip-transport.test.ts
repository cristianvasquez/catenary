import { describe, expect, it, vi } from 'vitest';
import { VIEW_CLIP_FORMAT } from '@catenary/model';
import { SystemClipWriter, VIEW_CLIP_WEB_TYPE, clipFormOf, clipIdOf, clipToken, rdfOf } from '../src/browser/diagram/clip-transport';

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

    it('a copy in another canvas whose export finishes first keeps the system clipboard: the older write does not run', async () => {
        const writer = new SystemClipWriter(), write = vi.fn(async () => undefined);
        let finishA!: (t: string) => void, finishB!: (t: string) => void;
        const a = writer.write('a', new Promise(r => { finishA = r; }), write);
        const b = writer.write('b', new Promise(r => { finishB = r; }), write);
        finishB('ttl b');
        await b;
        finishA('ttl a');
        await a;
        expect(write.mock.calls).toEqual([['ttl b', clipToken('b')]]);
    });

    it('a clear (a copy with nothing to copy) cancels a write still running', async () => {
        const writer = new SystemClipWriter(), write = vi.fn(async () => undefined);
        let finish!: (t: string) => void;
        const a = writer.write('a', new Promise(r => { finish = r; }), write);
        writer.cancel();
        finish('ttl a');
        await a;
        expect(write).not.toHaveBeenCalled();
    });

    it('no Turtle or a rejected write writes nothing and reports nothing', async () => {
        const writer = new SystemClipWriter(), write = vi.fn(async () => { throw new Error('denied'); });
        await expect(writer.write('a', Promise.resolve(undefined), write)).resolves.toBeUndefined();
        expect(write).not.toHaveBeenCalled();
        await expect(writer.write('b', Promise.resolve('ttl'), write)).resolves.toBeUndefined();
        expect(write).toHaveBeenCalledTimes(1);
    });
});
