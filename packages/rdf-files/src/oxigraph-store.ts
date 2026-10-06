// QuadStore on Oxigraph (in-memory, WASM). Oxigraph accepts RDF/JS terms of other factories (rdf-ext).

import type { Quad, Term } from '@rdfjs/types';
import * as ox from 'oxigraph';
import type { Bindings, QuadStore } from './store';

/** Parse RDF text at once (no stream). `mediaType`: for example text/turtle. Blank nodes stay blank nodes. */
export function parseRdfSync(text: string, mediaType: string): Quad[] {
    return ox.parse(text, { format: mediaType }) as unknown as Quad[];
}

export class OxigraphStore implements QuadStore {
    protected readonly store: ox.Store;

    constructor(quads: Iterable<Quad> = []) {
        this.store = new ox.Store();
        for (const q of quads) this.store.add(q as ox.Quad);
    }

    get size(): number { return this.store.size; }
    has(q: Quad): boolean { return this.store.has(q as ox.Quad); }
    add(q: Quad): void { this.store.add(q as ox.Quad); }
    delete(q: Quad): void { this.store.delete(q as ox.Quad); }

    match(s?: Term | null, p?: Term | null, o?: Term | null, g?: Term | null): Quad[] {
        return this.store.match(s as ox.Term ?? null, p as ox.Term ?? null, o as ox.Term ?? null, g as ox.Term ?? null) as unknown as Quad[];
    }

    select(query: string): Bindings[] {
        const rows = this.store.query(query);
        if (!Array.isArray(rows)) throw new Error('Not a SELECT query.');
        return (rows as Map<string, ox.Term>[]).map(m => Object.fromEntries(m) as unknown as Bindings);
    }

    construct(query: string): Quad[] {
        const quads = this.store.query(query);
        if (!Array.isArray(quads) || (quads.length && !('subject' in (quads[0] as object)))) throw new Error('Not a CONSTRUCT query.');
        return quads as unknown as Quad[];
    }
}
