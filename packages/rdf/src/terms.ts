// RDF/JS factory (rdf-ext, the full API), JSON -> term, and the prefixes of the TriG writer. The term keys are in rdf-files.
// Term -> JSON (termToJSON) is in @catenary/model: it needs no factory.

import { TermJSON } from '@catenary/model';
import rdf from 'rdf-ext';

export { rdf };
export { mapTerm, termKey, tripleKey } from 'rdf-files';

/** Prefixes used by the writers (defined in @catenary/model: the shape editor compacts IRIs with them). */
export { PREFIXES } from '@catenary/model';

export function jsonToTerm(t: TermJSON) {
    if (t.termType === 'NamedNode') return rdf.namedNode(t.value);
    if (t.language) return rdf.literal(t.value, t.language);
    return rdf.literal(t.value, t.datatype ? rdf.namedNode(t.datatype) : undefined);
}
