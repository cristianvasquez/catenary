import type { Quad } from '@rdfjs/types'

/** Return canonical N-Quads using RDFC-1.0, including Catenary's RDF 1.2 term encoding. */
export function canonicalNQuads(quads: Iterable<Quad>): string

/** Serialize an RDF dataset as Turtle or TriG. */
export function triplify(dataset: Iterable<Quad>, prefixes?: Record<string, string>): Promise<string>
