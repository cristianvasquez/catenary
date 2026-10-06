// Terms as JSON, namespaces and IRI helpers. No RDF library: TermLike is the shape of any RDF/JS term.

export const NS = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    owl: 'http://www.w3.org/2002/07/owl#',
    sh: 'http://www.w3.org/ns/shacl#',
    skos: 'http://www.w3.org/2004/02/skos/core#',
    dct: 'http://purl.org/dc/terms/',
    view: 'osg://vocab/view#',
    ws: 'osg://vocab/workspace#'
};

export const XSD_STRING = NS.xsd + 'string';
export const RDF_TYPE = NS.rdf + 'type';
export const RDFS_LABEL = NS.rdfs + 'label';

/** An RDF term as JSON: IRIs and literals only. */
export interface TermJSON {
    termType: 'NamedNode' | 'Literal';
    value: string;
    datatype?: string;   // Literal only. Absent means xsd:string (or rdf:langString with language)
    language?: string;
}

/** The fields of an RDF/JS term that this package reads. */
export interface TermLike {
    termType: string;
    value: string;
    language?: string;
    datatype?: { value: string };
}

/** The fields of an RDF/JS quad that this package reads. */
export interface QuadLike {
    subject: TermLike;
    predicate: TermLike;
    object: TermLike;
}

export function localName(iri: string): string {
    const m = /[#/:]([^#/:]+)[#/]?$/.exec(iri);
    return m ? decodeURIComponent(m[1]) : iri;
}

/** JSON form of an IRI or literal. Undefined for blank nodes and other terms. */
export function termToJSON(t: TermLike): TermJSON | undefined {
    if (t.termType === 'NamedNode') return { termType: 'NamedNode', value: t.value };
    if (t.termType === 'Literal') {
        const json: TermJSON = { termType: 'Literal', value: t.value };
        if (t.language) json.language = t.language;
        else if (t.datatype && t.datatype.value !== XSD_STRING) json.datatype = t.datatype.value;
        return json;
    }
    return undefined;
}

/** Stable text of a term, for sorting and comparison. */
export function termKey(t: TermJSON): string {
    return t.termType === 'NamedNode' ? `<${t.value}>` : `"${t.value}"@${t.language ?? ''}^^${t.datatype ?? ''}`;
}
