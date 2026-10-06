// The quad store port. The caller chooses the implementation (for example oxigraph-store.ts). The store is local and synchronous:
// an edit reads its own writes inside one transaction. A remote triplestore fits as a source or sink of load and save, not here.

import type { Quad, Term } from '@rdfjs/types';

export type Bindings = Record<string, Term>;

export interface QuadStore {
    readonly size: number;
    has(q: Quad): boolean;
    add(q: Quad): void;
    delete(q: Quad): void;
    /** Quads that match the pattern. null or undefined: any term. */
    match(s?: Term | null, p?: Term | null, o?: Term | null, g?: Term | null): Quad[];
    /** Result rows of a SPARQL SELECT. */
    select(query: string): Bindings[];
    /** The triples of a SPARQL CONSTRUCT (default graph quads). */
    construct(query: string): Quad[];
}
