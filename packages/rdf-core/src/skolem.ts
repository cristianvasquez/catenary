// Blank nodes -> IRIs, at the read of every file and of every result that has blank nodes (AGENTS.md: Catenary has no blank nodes).
// One read assigns one IRI `<SKOLEM_BASE><uuid>` to each blank node. A quoted triple uses the same IRI inside and outside.

import type { BlankNode, NamedNode, Quad, Term } from '@rdfjs/types';
import { randomUUID } from 'crypto';
import { mapTerm, rdf } from './terms';

export const SKOLEM_BASE = 'urn:skolem:';

/** An IRI that a read made from a blank node: it belongs to the node that refers to it. */
export const isSkolem = (t: Term) => t.termType === 'NamedNode' && t.value.startsWith(SKOLEM_BASE);

/** The quads with an IRI for each blank node, and the number of blank nodes. */
export function skolemize(quads: Quad[]): { quads: Quad[]; count: number } {
    const names = rdf.termMap<BlankNode, NamedNode>();
    const iri = (b: BlankNode) => names.get(b) ?? names.set(b, skolemIri()).get(b)!;
    const map = <T extends Term>(t: T): T => mapTerm(t, y => (y.termType === 'BlankNode' ? iri(y) : y));
    return { quads: quads.map(q => rdf.quad(map(q.subject), q.predicate, map(q.object), map(q.graph))), count: names.size };
}

/** A new IRI of the skolem form, for a node that belongs to another (a copied nested value). */
export const skolemIri = (): NamedNode => rdf.namedNode(SKOLEM_BASE + randomUUID());
