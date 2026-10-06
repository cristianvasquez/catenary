// Quads as plain values for postMessage to a worker thread (structured clone), and back to RDF/JS terms. RDF 1.2 triple terms and
// directional literals included: no parser is involved.

import type { Quad, Term } from '@rdfjs/types';
import { rdf } from './terms';

export type PlainTerm =
    | { t: 'NamedNode' | 'BlankNode'; v: string }
    | { t: 'Literal'; v: string; l?: string; d?: string; dir?: string }
    | { t: 'DefaultGraph' }
    | { t: 'Quad'; s: PlainTerm; p: PlainTerm; o: PlainTerm; g: PlainTerm };

export function toPlain(t: Term): PlainTerm {
    switch (t.termType) {
        case 'Literal': {
            const dir = (t as { direction?: string }).direction;
            return { t: 'Literal', v: t.value, ...(t.language ? { l: t.language } : { d: t.datatype.value }), ...(dir ? { dir } : {}) };
        }
        case 'DefaultGraph': return { t: 'DefaultGraph' };
        case 'Quad': return { t: 'Quad', s: toPlain(t.subject), p: toPlain(t.predicate), o: toPlain(t.object), g: toPlain(t.graph) };
        case 'BlankNode': return { t: 'BlankNode', v: t.value };
        default: return { t: 'NamedNode', v: t.value };
    }
}

export function fromPlain(p: PlainTerm): Term {
    switch (p.t) {
        case 'NamedNode': return rdf.namedNode(p.v);
        case 'BlankNode': return rdf.blankNode(p.v);
        case 'DefaultGraph': return rdf.defaultGraph();
        case 'Literal': return p.l ? (rdf.literal as (v: string, l: unknown) => Term)(p.v, p.dir ? { language: p.l, direction: p.dir } : p.l) : rdf.literal(p.v, rdf.namedNode(p.d!));
        case 'Quad': return rdf.quad(fromPlain(p.s) as Quad['subject'], fromPlain(p.p) as Quad['predicate'], fromPlain(p.o) as Quad['object'], fromPlain(p.g) as Quad['graph']);
    }
}

export const quadsToPlain = (quads: Iterable<Quad>): PlainTerm[] => [...quads].map(toPlain);
export const plainToQuads = (plain: PlainTerm[]): Quad[] => plain.map(p => fromPlain(p) as Quad);
