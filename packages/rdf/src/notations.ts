// The input of the notation engine (@catenary/model notation.ts): the built-in notation files of the app (packages/rdf/notations, copied
// next to the backend bundle by scripts/esbuild-catenary.mjs) and the triples of the store, as JSON.

import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import type { Quad, Term } from '@rdfjs/types';
import { NQuad, NTerm, Notations, TermJSON, TripleIndex, notations, termToJSON } from '@catenary/model';
import { parseRdfSync } from 'rdf-files';
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
    const n = notations(nquads(skolemize(quads.map(q => rdf.quad(q.subject, q.predicate, q.object))).quads));
    if (dir === NOTATIONS_DIR) builtIn = n;
    return n;
}

/** The engine input of a store: all its quads except the validation report. */
export function storeIndex(g: ModelGraph): TripleIndex {
    const report = rdf.namedNode(VALIDATION_GRAPH);
    return new TripleIndex(nquads(g.quads().filter(q => !q.graph.equals(report))));
}
