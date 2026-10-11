// Blank nodes -> IRIs, at the read of every file and of every result that has blank nodes (AGENTS.md: Catenary has no blank nodes).
// One read assigns one IRI `<base><uuid>` to each blank node. A quoted triple uses the same IRI inside and outside.
// The skolem prefix is a defined value of the contract (manifest §1 skolemPrefix): urn:skolem:<uuid>. `skolemizer` lets another host use its own base.

import type { BlankNode, NamedNode, Quad, Term } from '@rdfjs/types';
import { randomUUID } from 'crypto';
import { mapTerm, rdf } from './terms';

export interface Skolemizer {
    /** An IRI that a read made from a blank node: it belongs to the node that refers to it. */
    isSkolem(t: Term): boolean;
    /** The quads with an IRI for each blank node, and the number of blank nodes. */
    skolemize(quads: Quad[]): { quads: Quad[]; count: number };
    /** A new IRI of the skolem form, for a node that belongs to another (a copied nested value). */
    skolemIri(): NamedNode;
}

/** The skolem functions for the IRI prefix `base`. */
export function skolemizer(base: string): Skolemizer {
    const skolemIri = (): NamedNode => rdf.namedNode(base + randomUUID());
    return {
        isSkolem: t => t.termType === 'NamedNode' && t.value.startsWith(base),
        skolemize(quads) {
            const names = rdf.termMap<BlankNode, NamedNode>();
            const iri = (b: BlankNode) => names.get(b) ?? names.set(b, skolemIri()).get(b)!;
            const map = <T extends Term>(t: T): T => mapTerm(t, y => (y.termType === 'BlankNode' ? iri(y) : y));
            return { quads: quads.map(q => rdf.quad(map(q.subject), q.predicate, map(q.object), map(q.graph))), count: names.size };
        },
        skolemIri
    };
}

/** The skolem prefix of the contract. */
export const SKOLEM_BASE = 'urn:skolem:';
export const { isSkolem, skolemize, skolemIri } = skolemizer(SKOLEM_BASE);
