// The forms of a canvas clip in the system clipboard (spec/ui-manifest.hs §5.8, law_pasteOrder). Ctrl+C and Ctrl+X write the
// clip token in a custom type and the Turtle of Copy as RDF as text/plain. A paste resolves the custom type, then a text/plain token, then RDF.

import { VIEW_CLIP_FORMAT } from '@catenary/model';

/** The custom type in the asynchronous Clipboard API. A DataTransfer names it VIEW_CLIP_FORMAT. */
export const VIEW_CLIP_WEB_TYPE = `web ${VIEW_CLIP_FORMAT}`;

/** The media types that a paste reads as RDF, before text/plain. */
export const RDF_MEDIA_TYPES = ['text/turtle', 'application/trig', 'application/n-triples', 'application/n-quads',
    'application/ld+json', 'application/rdf+xml', 'text/n3'];

/** The token text of a clip: a JSON object with one key, `clipboardId`. */
export function clipToken(clipboardId: string): string {
    return JSON.stringify({ clipboardId });
}

/** The clip id of a token text. A JSON object with more keys (JSON-LD) is not a token. */
export function clipIdOfToken(text: string): string | undefined {
    try {
        const token = JSON.parse(text);
        return token && typeof token === 'object' && Object.keys(token).length === 1 && typeof token.clipboardId === 'string'
            ? token.clipboardId : undefined;
    } catch {
        return undefined;
    }
}

/** The clip id in the clipboard: the custom type first, then a token in text/plain. */
export function clipIdOf(types: readonly string[], getData: (type: string) => string): string | undefined {
    for (const type of [VIEW_CLIP_WEB_TYPE, VIEW_CLIP_FORMAT, 'text/plain']) {
        const id = types.includes(type) ? clipIdOfToken(getData(type)) : undefined;
        if (id) return id;
    }
    return undefined;
}

/** The RDF in the clipboard: the first RDF media type, else text/plain. */
export function rdfOf(types: readonly string[], getData: (type: string) => string): { text: string; mediaType?: string } {
    const mediaType = RDF_MEDIA_TYPES.find(type => types.includes(type));
    return { text: getData(mediaType ?? 'text/plain'), mediaType };
}

/** The form of the clipboard content (law_pasteOrder): a clip token (custom type or text/plain), else RDF, else nothing. */
export function clipFormOf(types: readonly string[], getData: (type: string) => string): 'token' | 'rdf' | 'none' {
    if (clipIdOf(types, getData)) return 'token';
    return rdfOf(types, getData).text.trim() ? 'rdf' : 'none';
}

/**
 * The asynchronous system clipboard writes of the window. All canvases share one system clipboard: a write runs only when its clip
 * is still the newest copy or cut of the window, so that an older export that finishes last does not replace a newer clip.
 */
export class SystemClipWriter {
    protected latest?: string;

    /** Write the Turtle and the token of a clip when the Turtle arrives. No Turtle, a newer clip or a rejected write: nothing. */
    write(clipboardId: string, turtle: Promise<string | undefined>, write: (turtle: string, token: string) => Promise<void>): Promise<void> {
        this.latest = clipboardId;
        return turtle.then(text => text !== undefined && this.latest === clipboardId ? write(text, clipToken(clipboardId)) : undefined)
            .catch(() => undefined);
    }

    /** A clear of the clip (a copy with nothing to copy): a write still running writes nothing. */
    cancel(): void {
        this.latest = undefined;
    }
}

export const systemClipWriter = new SystemClipWriter();
