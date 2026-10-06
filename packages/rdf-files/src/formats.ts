// RDF file formats by file extension: read, canonical form, and write. The same content gives the same bytes.

import type { Quad } from '@rdfjs/types';
import { canonicalNQuads, triplify } from 'rdf-serialization';
import * as path from 'path';
import { fileIri } from './paths';
import { rdf, termKey, tripleKey } from './terms';

/** RDF formats by extension (`.json`: only documents with `@context`). `write`: `serializeRdf` also writes it. */
export const RDF_FORMATS: { extensions: string[]; mediaType: string; write: boolean }[] = [
    { extensions: ['.ttl', '.turtle'], mediaType: 'text/turtle', write: true },
    { extensions: ['.trig'], mediaType: 'application/trig', write: true },
    { extensions: ['.nt'], mediaType: 'application/n-triples', write: true },
    { extensions: ['.nq'], mediaType: 'application/n-quads', write: true },
    { extensions: ['.jsonld', '.json'], mediaType: 'application/ld+json', write: true },
    { extensions: ['.n3'], mediaType: 'text/n3', write: false },
    { extensions: ['.rdf', '.owl', '.xml'], mediaType: 'application/rdf+xml', write: false }
];

/** File extensions of RDF_FORMATS, without the dot. */
export const RDF_EXTENSIONS = RDF_FORMATS.flatMap(f => f.extensions.map(e => e.slice(1)));

export function formatOf(file: string) {
    const ext = path.extname(file).toLowerCase();
    return RDF_FORMATS.find(f => f.extensions.includes(ext));
}

/** Undefined, or why `serializeRdf` cannot write this file. */
export function writeProblem(file: string): string | undefined {
    const f = formatOf(file);
    if (!f) return `${path.basename(file)}: unknown RDF format (extensions: ${RDF_EXTENSIONS.join(', ')})`;
    if (!f.write) return `${path.basename(file)}: ${f.mediaType} is read only (no writer). Use .ttl, .nt, .nq, .trig or .jsonld`;
    return undefined;
}

/** Parse an RDF file of any known format. The file name gives the format and the base IRI. */
export async function parseRdf(text: string, file: string): Promise<Quad[]> {
    const f = formatOf(file);
    if (!f) throw new Error(`unknown RDF format (extensions: ${RDF_EXTENSIONS.join(', ')})`);
    const dataset = await rdf.io.dataset.fromText(f.mediaType, text, { baseIRI: fileIri(file) });
    return [...dataset];
}

/** The quads without duplicates (a dataset; the key keeps the direction of a literal). */
export function uniqueQuads(quads: Iterable<Quad>): Quad[] {
    return [...new Map([...quads].map(q => [`${tripleKey(q)} ${termKey(q.graph)}`, q])).values()];
}

/**
 * Canonical N-Quads (RDFC-1.0) of quads: the same content gives the same text. RDF 1.2 terms included. Without blank nodes
 * and RDF 1.2 terms, RDFC-1.0 gives the sorted N-Quads lines of rdf-canonize: this function writes them without the canonicalization.
 */
export function canonical(quads: Iterable<Quad>): string {
    const all = [...quads];
    if (!all.every(plainQuad)) return canonicalNQuads(uniqueQuads(all));
    // Equal lines are equal quads (the escapes are one to one): the sorted lines without repeats.
    const lines = all.map(q => `${nq(q.subject)} ${nq(q.predicate)} ${nq(q.object)}${q.graph.termType === 'NamedNode' ? ' ' + nq(q.graph) : ''} .\n`).sort();
    return lines.filter((l, i) => i === 0 || l !== lines[i - 1]).join('');
}

/** A quad of IRIs and literals without a base direction, in a named or the default graph. */
const plainQuad = (q: Quad) => q.subject.termType === 'NamedNode' && q.predicate.termType === 'NamedNode'
    && (q.object.termType === 'NamedNode' || (q.object.termType === 'Literal' && !(q.object as { direction?: string }).direction))
    && (q.graph.termType === 'NamedNode' || q.graph.termType === 'DefaultGraph');

// The escapes of rdf-canonize (NQuads.serializeQuadComponents): UCHAR for the characters below, ECHAR for some of them.
const IRI_ESCAPE = /[\u0000-\u0020<>"{}|^`\\]/g;
const LITERAL_ESCAPE = /[\u0000-\u001F\u007F"\\]/g;
const ECHAR: Record<string, string> = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\' };
const uchar = (c: string) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string', RDF_LANGSTRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

function nq(t: Quad['subject'] | Quad['predicate'] | Quad['object'] | Quad['graph']): string {
    if (t.termType !== 'Literal') return `<${t.value.replace(IRI_ESCAPE, uchar)}>`;
    const text = `"${t.value.replace(LITERAL_ESCAPE, c => ECHAR[c] ?? uchar(c))}"`;
    if (t.datatype.value === RDF_LANGSTRING) return t.language ? `${text}@${t.language}` : text;
    return t.datatype.value === XSD_STRING ? text : `${text}^^<${t.datatype.value.replace(IRI_ESCAPE, uchar)}>`;
}

/** Write triples (default graph) in the format of the file. Canonical first: the same content gives the same bytes. */
export async function serializeRdf(quads: Iterable<Quad>, file: string, prefixes: Record<string, string> = {}): Promise<string> {
    const problem = writeProblem(file);
    if (problem) throw new Error(problem);
    const all = [...quads];
    if (formatOf(file)!.mediaType === 'application/ld+json' && all.some(q => q.subject.termType === 'Quad' || q.object.termType === 'Quad')) {
        throw new Error(`${path.basename(file)}: JSON-LD has no RDF 1.2 triple terms; not written. Use .ttl, .trig, .nt or .nq`);
    }
    const text = canonical(all);
    const { mediaType } = formatOf(file)!;
    if (mediaType === 'application/n-triples' || mediaType === 'application/n-quads') return text;
    const dataset = await rdf.io.dataset.fromText('application/n-quads', text);
    if (mediaType === 'application/ld+json') return await rdf.io.dataset.toText(mediaType, dataset) + '\n';
    return triplify(dataset, prefixes);
}
