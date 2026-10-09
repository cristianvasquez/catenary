// The input of the notation engine (@catenary/model notation.ts): the built-in notation files of the app (packages/rdf/notations, copied
// next to the backend bundle by scripts/esbuild-catenary.mjs) and the triples of the store, as JSON.

import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import type { Quad, Term } from '@rdfjs/types';
import { NQuad, NS, NTerm, Notations, TermJSON, TripleIndex, notations, termToJSON } from '@catenary/model';
import { Bindings, QuadStore, parseRdfSync } from 'rdf-files';
import { ModelGraph, VALIDATION_GRAPH } from './graph';
import { skolemize } from './skolem';
import { rdf } from './terms';

/** The folder of the built-in notation files: next to the package source or build, or next to the backend bundle. */
export const NOTATIONS_DIR = [path.join(__dirname, '..', 'notations'), path.join(__dirname, 'notations')].find(d => existsSync(d))
    ?? path.join(__dirname, '..', 'notations');

/** A term of the store as JSON. Undefined: a blank node (the store has none) or another term. */
function nterm(t: Term): NTerm | undefined {
    if (t.termType === 'Quad') {
        const s = nterm(t.subject), p = termToJSON(t.predicate), o = nterm(t.object);
        return s && p && o ? { termType: 'Triple', value: '', subject: s, predicate: p, object: o } : undefined;
    }
    return termToJSON(t);
}

/** Quads as engine triples. The graph is dropped: the engine reads the union of all graphs. */
export function nquads(quads: Iterable<Quad>): NQuad[] {
    const out: NQuad[] = [];
    for (const q of quads) {
        const s = nterm(q.subject), o = nterm(q.object);
        if (s?.termType === 'NamedNode' && o) out.push({ subject: s as TermJSON, predicate: q.predicate.value, object: o });
    }
    return out;
}

let builtIn: Notations | undefined;

/** The notations: all `*.ttl` files of `dir`, blank nodes replaced by IRIs. The built-in folder is read once. */
export function readNotations(dir = NOTATIONS_DIR): Notations {
    if (dir === NOTATIONS_DIR && builtIn) return builtIn;
    const quads: Quad[] = [];
    for (const f of readdirSync(dir).filter(f => f.endsWith('.ttl')).sort())
        quads.push(...parseRdfSync(readFileSync(path.join(dir, f), 'utf8'), 'text/turtle'));
    if (dir === NOTATIONS_DIR && !existsSync(path.join(dir, 'shapes.ttl'))) quads.push(...parseRdfSync(readFileSync(require.resolve('@catenary/shacl/notations/shapes.ttl'), 'utf8'), 'text/turtle'));
    const n = notations(nquads(skolemize(quads.map(q => rdf.quad(q.subject, q.predicate, q.object))).quads));
    if (dir === NOTATIONS_DIR) builtIn = n;
    return n;
}

/**
 * Predicates of the geometry and the style of a placement. A change of these only moves, resizes or restyles what a view shows: the
 * figures do not read them (no built-in notation names them, test indexed-store.test.ts).
 */
export const LAYOUT_PREDICATES = new Set(['x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide'].map(p => NS.view + p));

const isReport = (q: Quad) => q.graph.termType === 'NamedNode' && q.graph.value === VALIDATION_GRAPH;

/**
 * The engine input of a store: all its quads except the validation report. A store that keeps the input (IndexedStore) gives its
 * index, kept in step with each change; another store builds it from all quads.
 */
export function storeIndex(g: ModelGraph): TripleIndex {
    if (g.store instanceof IndexedStore) return g.store.index();
    return new TripleIndex(nquads(g.quads().filter(q => !isReport(q))));
}

/**
 * A quad store that keeps the engine input of its quads (`storeIndex`) in step with each `add` and `delete`: a change does not build
 * it again from all quads, so the cost of a view does not grow with the store. The index is built at the first read.
 */
export class IndexedStore implements QuadStore {
    protected live?: TripleIndex;
    /** Changes with each add and delete, except of the validation report and of LAYOUT_PREDICATES: the figures and the other reads of a view key on it. */
    dataVersion = 0;

    constructor(protected readonly inner: QuadStore) {}

    get size(): number { return this.inner.size; }
    has(q: Quad): boolean { return this.inner.has(q); }
    match(s?: Term | null, p?: Term | null, o?: Term | null, g?: Term | null): Quad[] { return this.inner.match(s, p, o, g); }
    select(query: string): Bindings[] { return this.inner.select(query); }
    construct(query: string): Quad[] { return this.inner.construct(query); }

    add(q: Quad): void {
        this.count(q);
        if (!this.live || isReport(q) || this.inner.has(q)) return this.inner.add(q);
        this.inner.add(q);
        for (const x of nquads([q])) this.live.add(x);
    }

    delete(q: Quad): void {
        this.count(q);
        if (!this.live || isReport(q) || !this.inner.has(q)) return this.inner.delete(q);
        this.inner.delete(q);
        for (const x of nquads([q])) this.live.delete(x);
    }

    protected count(q: Quad): void {
        if (!isReport(q) && !LAYOUT_PREDICATES.has(q.predicate.value)) this.dataVersion++;
    }

    index(): TripleIndex {
        return this.live ??= new TripleIndex(nquads(this.inner.match().filter(q => !isReport(q))));
    }
}
