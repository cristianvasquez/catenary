// The input of the notation engine (@catenary/model notation.ts): the built-in notation files of the app (packages/rdf/notations, copied
// next to the backend bundle by scripts/esbuild-catenary.mjs) and the triples of the store, as JSON, read around one view.

import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import type { Quad, Term } from '@rdfjs/types';
import { Derivation, LazyTripleIndex, NQuad, NTerm, Notations, TermJSON, TripleIndex, ViewFigures, deriveFigures, notations, placementsOf, termToJSON, viewFigures } from '@catenary/model';
import { parseRdfSync } from 'rdf-files';
import { ModelGraph, VALIDATION_GRAPH } from './graph';
import { skolemize } from './skolem';
import { jsonToTerm, rdf } from './terms';

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

export { LAYOUT_PREDICATES } from './graph';

const isReport = (q: Quad) => q.graph.termType === 'NamedNode' && q.graph.value === VALIDATION_GRAPH;

/** An engine term as a store term. Undefined: a term that no statement of the store can have. */
function storeTerm(t: NTerm): Term | undefined {
    if (t.termType !== 'Triple') return jsonToTerm(t);
    const s = storeTerm(t.subject), o = storeTerm(t.object);
    return s && o ? rdf.quad(s as Quad['subject'], rdf.namedNode(t.predicate.value), o as Quad['object']) : undefined;
}

/**
 * The engine input of a store, read on demand (LazyTripleIndex): all graphs except the validation report. A view reads the triples
 * around its elements only. Make a new one after each change: it keeps what it read.
 */
export function storeInput(g: ModelGraph): TripleIndex {
    const read = (s?: Term, p?: Term, o?: Term) => nquads(g.store.match(s, p, o, null).filter(q => !isReport(q)));
    return new LazyTripleIndex({
        outgoing: s => { const t = storeTerm(s); return t && t.termType !== 'Literal' ? read(t) : []; },
        incoming: (o, p) => { const t = storeTerm(o); return t ? read(undefined, p === undefined ? undefined : rdf.namedNode(p), t) : []; },
        withPredicate: p => read(undefined, rdf.namedNode(p))
    });
}

/** The whole store as one engine input. For tests and comparisons: a view reads `storeInput`, not this. */
export function storeIndex(g: ModelGraph): TripleIndex {
    return new TripleIndex(nquads(g.quads().filter(q => !isReport(q))));
}

/** A placement key (nkey) as an engine term: an IRI, or a statement between IRIs. */
export function keyTerm(k: string): NTerm {
    const m = /^<<\(<([^<>]*)> <([^<>]*)> <([^<>]*)>\)>>$/.exec(k);
    if (m) return { termType: 'Triple', value: '', subject: { termType: 'NamedNode', value: m[1] }, predicate: { termType: 'NamedNode', value: m[2] }, object: { termType: 'NamedNode', value: m[3] } };
    const iri = /^<([^<>]*)>$/.exec(k);
    return { termType: 'NamedNode', value: iri ? iri[1] : k };
}

/**
 * The figures of a view and their join, from the store read around the view (law_scopedFiguresPreservePlacementRules). `also`: terms
 * that the view does not place yet but that the caller asks about (removed placements, pasted elements). `derivation`: an earlier one,
 * kept while the store changed only in what the figures do not read.
 */
export function viewFiguresOf(g: ModelGraph, viewIri: string, also: Iterable<NTerm> = [], derivation?: Derivation): ViewFigures {
    const D = storeInput(g), notes = readNotations();
    const placed = placementsOf(D, viewIri);
    return viewFigures(D, notes, viewIri, derivation ?? deriveFigures(D, notes, viewIri, [...[...placed.keys()].map(keyTerm), ...also]));
}
