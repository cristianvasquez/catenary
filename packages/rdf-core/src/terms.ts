// RDF/JS factory (rdf-ext, the full API) and JSON -> term. The term keys are in rdf-files.

import rdf from 'rdf-ext';

export { rdf };
export { mapTerm, termKey, tripleKey } from 'rdf-files';

/** An RDF term as JSON: IRIs and literals only. The Catenary model package has the same type (TermJSON) for the browser. */
export interface TermJSON {
    termType: 'NamedNode' | 'Literal';
    value: string;
    /** Literal only. Absent means xsd:string (or rdf:langString with a language). */
    datatype?: string;
    language?: string;
}

export function jsonToTerm(t: TermJSON) {
    if (t.termType === 'NamedNode') return rdf.namedNode(t.value);
    if (t.language) return rdf.literal(t.value, t.language);
    return rdf.literal(t.value, t.datatype ? rdf.namedNode(t.datatype) : undefined);
}
