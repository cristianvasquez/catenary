// TriG read and write. Read: @rdfjs/formats (through rdf-ext). Write: Catenary's vendored triplify serializer
// (@rdfjs/formats Turtle serializer, one block per named graph).
// The quads are canonicalized first (URDNA2015: stable blank node labels and quad order) and the model graph
// goes first (after the manifest of a workspace file), so that the same content gives the same bytes, whatever the order of the edits.

import type { Quad } from '@rdfjs/types';
import { triplify } from 'rdf-serialization';
import { canonical } from 'rdf-files';
import { MANIFEST_GRAPH } from './files';
import { MODEL_GRAPH } from './graph';
import { PREFIXES, rdf } from './terms';

export { canonical };

export interface ParseResult { quads: Quad[]; warnings: string[] }

/** Parse TriG. Default graph triples go to the model graph. */
export async function parseTrig(text: string): Promise<ParseResult> {
    const dataset = await rdf.io.dataset.fromText('application/trig', text);
    const model = rdf.namedNode(MODEL_GRAPH);
    const warnings: string[] = [];
    const quads = [...dataset].map(q => {
        if (q.graph.termType !== 'DefaultGraph') return q;
        if (!warnings.length) warnings.push('default graph read as the model graph');
        return rdf.quad(q.subject, q.predicate, q.object, model);
    });
    return { quads, warnings };
}

export async function writeTrig(quads: Iterable<Quad>): Promise<string> {
    const dataset = await rdf.io.dataset.fromText('application/n-quads', canonical(quads));
    const rank = (q: Quad) => (q.graph.value === MANIFEST_GRAPH ? '0' : q.graph.value === MODEL_GRAPH ? '1' : '2' + q.graph.value);
    const sorted = [...dataset].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
    return triplify(sorted, PREFIXES);
}
