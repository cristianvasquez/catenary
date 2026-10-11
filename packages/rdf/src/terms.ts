// RDF/JS factory, JSON -> term (rdf-core), and the prefixes of the TriG writer.
// Term -> JSON (termToJSON) is in @catenary/model: it needs no factory.

export { jsonToTerm, mapTerm, rdf, termKey, tripleKey } from 'rdf-core';

/** Prefixes used by the writers (defined in @catenary/model: the shape editor compacts IRIs with them). */
export { PREFIXES } from '@catenary/model';
