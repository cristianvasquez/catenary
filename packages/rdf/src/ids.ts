// Element ids for the UI and GLSP. An id is a reversible encoding of RDF terms, not state:
//   n-<iri>             instance or view (named node)
//   r-<s>-<p>-<o>       relation (triple of the model graph)
//   n-<iri>             node shape (shapes graphs)
//   p-<s>-<path>-<r>    property shape of node shape s: its path (SPARQL path text, full IRIs) and its range key (see shapes-read.ts)
//   c-<op>-<s>-<n>      logical constraint (sh:or, sh:xone, sh:and, sh:not) of node shape s, the n-th of that operator
// Characters other than [A-Za-z0-9] are escaped as _xx (UTF-8 bytes, hex). The ids are safe as DOM ids and
// in URI paths, and never contain "_" followed by a non-hex character (so the suffix "_label" is unambiguous).
// A change of IRI gives a new id.

import { escapeId, idIri, iriId, unescapeId } from '@catenary/model';
import type { NamedNode } from '@rdfjs/types';
import { rdf } from './terms';

const escape = escapeId, unescape = unescapeId;
// An absolute IRI (the store rejects others): a wrong id gives undefined, not an exception.
const IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]*$/;
const iri = (value: string | undefined) => value !== undefined && IRI.test(value) ? rdf.namedNode(value) : undefined;

/** Id of an instance, view, view element or shape. The dataset has no blank nodes (see skolem.ts). */
export function elementId(t: NamedNode): string {
    return iriId(t.value);
}

/** Id of a relation (s, p, o). */
export function relationId(s: NamedNode, p: NamedNode, o: NamedNode): string {
    return `r-${escape(s.value)}-${escape(p.value)}-${escape(o.value)}`;
}

/** Term of an element id. Undefined for a relation id or a malformed id. */
export function elementTerm(id: string): NamedNode | undefined {
    return iri(idIri(id));
}

/** Triple of a relation id. */
export function relationTriple(id: string): { s: NamedNode; p: NamedNode; o: NamedNode } | undefined {
    const parts = id.split('-');
    if (parts.length !== 4 || parts[0] !== 'r') return undefined;
    const [s, p, o] = parts.slice(1).map(v => iri(unescape(v)));
    return s && p && o ? { s, p, o } : undefined;
}

/** Id of a property shape: derived from its node shape, path and range (not state). `n` > 1: the n-th with the same key. */
export function propertyShapeId(shape: NamedNode, path: string, range: string, n = 1): string {
    return `p-${escape(shape.value)}-${escape(path)}-${escape(range)}${n > 1 ? '-' + n : ''}`;
}

/** Id of a logical constraint of a node shape. */
export function constraintId(operator: string, shape: NamedNode, n: number): string {
    return `c-${operator}-${escape(shape.value)}-${n}`;
}
