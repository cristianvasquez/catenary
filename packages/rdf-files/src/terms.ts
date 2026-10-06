// RDF/JS factory (rdf-ext) and term keys.

import type { DataFactory, Quad, Term } from '@rdfjs/types';
import rdfExt from 'rdf-ext';

/** The rdf-ext factory, typed with the part that this package uses. A consumer that needs more of rdf-ext imports it directly. */
export interface RdfFactory extends DataFactory<Quad, Quad> {
    io: {
        dataset: {
            fromText(mediaType: string, text: string, options?: { baseIRI?: string }): Promise<Iterable<Quad>>;
            toText(mediaType: string, dataset: Iterable<Quad>): Promise<string>;
        };
    };
}

export const rdf = rdfExt as unknown as RdfFactory;

type KeyTerm = { termType: string; value: string; language?: string; direction?: string | null; datatype?: { value: string }; subject?: KeyTerm; predicate?: KeyTerm; object?: KeyTerm };

/**
 * Key of a term, as N-Triples text: `<iri>`, `_:label`, `"v"@lang--dir`, `"v"^^<datatype>`, `<<( s p o )>>` (RDF 1.2 triple term).
 * Two terms have the same key only if they are equal. Use it for every map or set of terms that can hold values.
 */
export function termKey(t: KeyTerm): string {
    switch (t.termType) {
        case 'NamedNode': return `<${t.value}>`;
        case 'BlankNode': return `_:${t.value}`;
        case 'Literal': return JSON.stringify(t.value) + (t.language ? `@${t.language}${t.direction ? `--${t.direction}` : ''}` : `^^<${t.datatype?.value}>`);
        case 'Quad': return `<<( ${termKey(t.subject!)} ${termKey(t.predicate!)} ${termKey(t.object!)} )>>`;
        case 'DefaultGraph': return '';
        default: return `?${t.value}`;
    }
}

/** Key of a statement: subject, predicate, object. The graph is not part of it. */
export const tripleKey = (q: { subject: KeyTerm; predicate: KeyTerm; object: KeyTerm }) => `${termKey(q.subject)} ${termKey(q.predicate)} ${termKey(q.object)}`;

/** `f` applied to a term, and inside a triple term to each of its parts (recursive). */
export function mapTerm<T extends Term>(t: T, f: (t: Term) => Term): T {
    if (t.termType !== 'Quad') return f(t) as T;
    const m = (x: Term) => mapTerm(x, f) as never;
    return rdf.quad(m(t.subject), m(t.predicate), m(t.object)) as unknown as T;
}
