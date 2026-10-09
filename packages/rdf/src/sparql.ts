// SPARQL fragments of the read rules, for queries that Oxigraph evaluates (one text for each rule). A fragment is pattern text; the
// caller gives the variable names. `n` makes the helper variables of a fragment unique when a query uses it more than once.

import { NS } from '@catenary/model';
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { ModelGraph, VALIDATION_GRAPH, labelFromIri } from './graph';

export const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX skos: <${NS.skos}> PREFIX sh: <${NS.sh}> PREFIX view: <${NS.view}>`;

export const iri = (value: string) => `<${value}>`;

/** The report graph (derived; not data). */
export const NOT_REPORT = `<${VALIDATION_GRAPH}>`;

/** A SPARQL string literal. */
export const str = (s: string) => JSON.stringify(s);

/** The triples of a CONSTRUCT with the prefixes above. */
export function construct(g: ModelGraph, query: string): Quad[] {
    return g.store.construct(`${PREFIXES} ${query}`);
}

/** Result rows of a SELECT with the prefixes above. */
export function rows(g: ModelGraph, query: string): Record<string, Term>[] {
    return g.store.select(`${PREFIXES} ${query}`) as unknown as Record<string, Term>[];
}

/** Types that are not things: the internals of the view files. */
export const HIDDEN_TYPES = ['view:Placement', 'view:Frame', 'view:Note', 'view:FileRef', 'view:EntityGroup'];

/** Predicates that are not things: RDF structure, and the vocabularies of the view files and of SHACL (by namespace). */
export const HIDDEN_PREDICATES = ['rdf:type', 'rdf:first', 'rdf:rest', 'rdf:reifies'];
const HIDDEN_NAMESPACES = ['view:', 'sh:'];

/**
 * The things and their types (binds ?s ?type ?g): a subject with a type (not HIDDEN_TYPES, not `alsoHidden`), and a subject with a
 * label and no type (type rdfs:Resource). Not the report graph.
 */
export function things(alsoHidden: string[] = [], s = '?s', type = '?type', graph = '?g', n = ''): string {
    return `{
            GRAPH ${graph} { ${s} rdf:type ${type} }
            FILTER (${type} NOT IN (${[...alsoHidden, ...HIDDEN_TYPES].join(', ')}))
        }
        UNION
        {
            GRAPH ${graph} { ${s} rdfs:label|skos:prefLabel ?anyLabel${n} }
            FILTER NOT EXISTS { GRAPH ?gt${n} { ${s} rdf:type ?anyType${n} } FILTER (?gt${n} != ${NOT_REPORT}) }
            BIND (rdfs:Resource AS ${type})
        }
        FILTER (${graph} != ${NOT_REPORT})`;
}

/** Statements of bound subjects across data graphs. */
export function statements(g: ModelGraph, subjects: string[]): Quad[] {
    if (!subjects.length) return [];
    return construct(g, `CONSTRUCT { ?s ?p ?o } WHERE {
        VALUES ?s { ${[...new Set(subjects)].map(iri).join(' ')} }
        GRAPH ?g { ?s ?p ?o } FILTER (?g != ${NOT_REPORT})
    }`);
}

/** Statements of one data graph. View readers use this query for placement metadata. */
export function graphStatements(g: ModelGraph, graph: string): Quad[] {
    if (graph === VALIDATION_GRAPH) return [];
    return construct(g, `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ${iri(graph)} { ?s ?p ?o } }`);
}

/** Statements between things. The predicate exclusions use the shared configuration. */
export function connections(s = '?s', p = '?p', o = '?o'): string {
    return `GRAPH ?connectionGraph { ${s} ${p} ${o} } FILTER (?connectionGraph != ${NOT_REPORT})
        FILTER (${p} NOT IN (${HIDDEN_PREDICATES.join(', ')}) ${HIDDEN_NAMESPACES.map(ns => `&& !STRSTARTS(STR(${p}), STR(${ns}))`).join(' ')})
        { ${things([], s, '?sourceType', '?sourceGraph', 'Source')} }
        { ${things([], o, '?targetType', '?targetGraph', 'Target')} }`;
}

/** One thing and its types. Labels use the shared label query. */
export function thingHead(g: ModelGraph, t: NamedNode): { label: string; types: string[] } | undefined {
    const found = construct(g, `CONSTRUCT { ?s rdf:type ?type } WHERE {
        VALUES ?s { ${iri(t.value)} } { ${things()} }
    }`);
    if (!found.length) return undefined;
    return { label: labels(g, [t.value]).get(t.value)!, types: [...new Set(found.map(q => q.object.value))].sort() };
}

/** The property shapes (binds ?s ?type ?g): the subjects of sh:path (SHACL 2.3), type sh:PropertyShape. */
export const PROPERTY_SHAPES = `{ GRAPH ?g { ?s sh:path ?anyPath } BIND (sh:PropertyShape AS ?type) }`;

/** Every thing with its type (`things`, without the shapes), and the broader class of the type. */
export function thingTypes(g: ModelGraph): Quad[] {
    return construct(g, `CONSTRUCT {
        ?s rdf:type ?type .
        ?type rdfs:subClassOf ?broader .
    } WHERE {
        ${things(['sh:NodeShape', 'sh:PropertyShape'])}
        OPTIONAL { GRAPH ?g2 { ?type rdfs:subClassOf ?broader } FILTER (?g2 != ${NOT_REPORT}) }
    }`);
}

/**
 * The display label of each IRI (one query; the one home of the label rule): rdfs:label, else skos:prefLabel, else sh:name (the first
 * in string order), else the name from the path IRI of a property shape, else the name from the IRI (labelFromIri, percent-decoded).
 */
export function labels(g: ModelGraph, iris: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (!iris.length) return out;
    const found = construct(g, `CONSTRUCT { ?s rdfs:label ?label . ?s sh:path ?path . } WHERE {
        { SELECT ?s (MIN(?name) AS ?label) (MIN(?simplePath) AS ?path) WHERE {
            VALUES ?s { ${[...new Set(iris)].map(iri).join(' ')} }
            OPTIONAL { GRAPH ?g1 { ?s rdfs:label ?rl } FILTER (?g1 != ${NOT_REPORT}) }
            OPTIONAL { GRAPH ?g2 { ?s skos:prefLabel ?pl } FILTER (?g2 != ${NOT_REPORT}) }
            OPTIONAL { GRAPH ?g3 { ?s sh:name ?sn } FILTER (?g3 != ${NOT_REPORT}) }
            OPTIONAL { GRAPH ?g4 { ?s sh:path ?simplePath } FILTER (?g4 != ${NOT_REPORT} && !STRSTARTS(STR(?simplePath), "urn:skolem:")) }
            BIND (COALESCE(STR(?rl), STR(?pl), STR(?sn)) AS ?name)
        } GROUP BY ?s }
    }`);
    const path = new Map<string, string>();
    for (const q of found) (q.predicate.value === NS.rdfs + 'label' ? out : path).set(q.subject.value, q.object.value);
    for (const s of iris) if (!out.has(s)) out.set(s, labelFromIri(path.get(s) ?? s));
    return out;
}

/** Case-insensitive label order, then lower case first. */
export const compareLabels = (a: string, b: string) => {
    const x = a.toLowerCase().replace(/[—→]/g, '\t'), y = b.toLowerCase().replace(/[—→]/g, '\t');
    return x < y ? -1 : x > y ? 1 : a < b ? 1 : a > b ? -1 : 0;
};

