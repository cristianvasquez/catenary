// Element ids: a reversible encoding of IRIs (all id forms: @catenary/rdf ids.ts). No RDF library: the user interface can address
// an element by its IRI (for example a concept that is only a row of its scheme card).
// Characters other than [A-Za-z0-9] are escaped as _xx (UTF-8 bytes, hex).

export function escapeId(s: string): string {
    let out = '';
    for (const ch of s) {
        if (/[A-Za-z0-9]/.test(ch)) { out += ch; continue; }
        let bytes: string[];
        try {
            const enc = encodeURIComponent(ch);
            bytes = enc.startsWith('%') ? enc.slice(1).split('%') : [ch.charCodeAt(0).toString(16)];
        } catch {
            bytes = ['ef', 'bf', 'bd'];   // a lone surrogate: U+FFFD, as TextEncoder writes it
        }
        for (const b of bytes) out += '_' + b.toLowerCase().padStart(2, '0');
    }
    return out;
}

export function unescapeId(s: string): string | undefined {
    if (!/^(?:[A-Za-z0-9]|_[0-9a-f]{2})*$/.test(s)) return undefined;
    try {
        return decodeURIComponent(s.replace(/_([0-9a-f]{2})/g, '%$1'));
    } catch {
        return undefined;
    }
}

/** Id of the element with this IRI (instance, view, view element, node shape, value set, concept). */
export function iriId(iri: string): string {
    return 'n-' + escapeId(iri);
}

/** IRI of an element id of the form "n-…"; undefined for other ids. */
export function idIri(id: string): string | undefined {
    const value = id.startsWith('n-') ? unescapeId(id.slice(2)) : undefined;
    return value || undefined;
}

/** Id of the relation (s, p, o), from the IRIs of its terms. */
export function relationIdOf(s: string, p: string, o: string): string {
    return `r-${escapeId(s)}-${escapeId(p)}-${escapeId(o)}`;
}

/** A relation given by the IRIs of its subject, predicate and object (the CLI accepts it where it accepts a relation id). */
export type TripleRef = { s: string; p: string; o: string };

export function isTripleRef(x: unknown): x is TripleRef {
    return !!x && typeof x === 'object' && ['s', 'p', 'o'].every(k => typeof (x as Record<string, unknown>)[k] === 'string');
}

/**
 * The id of an id, an IRI or a triple (manifest §1.3). Ids use only [A-Za-z0-9_-], so a value with ":" is an IRI: it gives its
 * element id. A CURIE is not expanded: it is an IRI. A triple gives its relation id. An id stays the same.
 */
export function canonicalId(x: string | TripleRef): string {
    if (typeof x !== 'string') return relationIdOf(x.s, x.p, x.o);
    return x.includes(':') ? iriId(x) : x;
}
