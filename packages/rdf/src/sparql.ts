// SPARQL fragments of the read rules, for queries that Oxigraph evaluates (one text for each rule). A fragment is pattern text; the
// caller gives the variable names. `n` makes the helper variables of a fragment unique when a query uses it more than once.

import { LABEL_PREDICATES, LabelLiteral, NS, compareLabels, pickLabel } from '@catenary/model';
import type { Literal, NamedNode, Quad, Quad_Object, Quad_Subject, Term } from '@rdfjs/types';
import { UNION_GRAPH, ModelGraph, REPORT_GRAPH, cmp } from './graph';
import { rdf } from './terms';
import { labelFromIri } from './vocabulary';

export const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX skos: <${NS.skos}> PREFIX sh: <${NS.sh}> PREFIX view: <${NS.view}>`;

export const iri = (value: string) => `<${value}>`;

/** The report graph (derived; not data). */
export const NOT_REPORT = `<${REPORT_GRAPH}>`;

/** A SPARQL string literal. */
export const str = (s: string) => JSON.stringify(s);

/** The triples of a CONSTRUCT with the prefixes above. */
export function construct(g: ModelGraph, query: string): Quad[] {
    return g.construct(`${PREFIXES} ${query}`);
}

/** Result rows of a SELECT with the prefixes above. */
export function rows(g: ModelGraph, query: string): Record<string, Term>[] {
    return g.select(`${PREFIXES} ${query}`) as unknown as Record<string, Term>[];
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
    if (graph === REPORT_GRAPH) return [];
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
 * The display label of each IRI (one query; the label rule is pickLabel, @catenary/model): the literals of rdfs:label, else
 * skos:prefLabel, else sh:name, in the language of the graph (ModelGraph.language), else the name from the path IRI of a property
 * shape, else the name from the IRI (labelFromIri, percent-decoded).
 */
export function labels(g: ModelGraph, iris: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (!iris.length) return out;
    const found = rows(g, `SELECT DISTINCT ?s ?p ?l WHERE {
        VALUES ?s { ${[...new Set(iris)].map(iri).join(' ')} }
        { GRAPH ?g1 { ?s ?p ?l } FILTER (?g1 != ${NOT_REPORT} && ?p IN (rdfs:label, skos:prefLabel, sh:name) && isLiteral(?l)) }
        UNION { GRAPH ?g2 { ?s sh:path ?l } FILTER (?g2 != ${NOT_REPORT} && !STRSTARTS(STR(?l), "urn:skolem:")) BIND (sh:path AS ?p) }
    }`);
    const literals = new Map<string, LabelLiteral[][]>(), path = new Map<string, string>();
    for (const r of found) {
        const s = r.s.value;
        if (r.p.value === NS.sh + 'path') {
            const was = path.get(s);
            if (was === undefined || cmp(r.l.value, was) < 0) path.set(s, r.l.value);
            continue;
        }
        const lists = literals.get(s) ?? literals.set(s, LABEL_PREDICATES.map(() => [])).get(s)!;
        lists[LABEL_PREDICATES.indexOf(r.p.value as typeof LABEL_PREDICATES[number])].push({ value: r.l.value, language: (r.l as Literal).language });
    }
    for (const s of iris) out.set(s, pickLabel(literals.get(s) ?? [], g.language) ?? labelFromIri(path.get(s) ?? s));
    return out;
}

export { compareLabels };

/** The IRIs of `iris` with an rdf:type or an rdfs:label in the model graph (vocabulary.ts inModel), in one query. */
export function inModelAmong(g: ModelGraph, iris: Iterable<string>): Set<string> {
    const values = [...new Set(iris)].filter(s => s !== g.union.value);
    if (!values.length) return new Set();
    return new Set(rows(g, `SELECT DISTINCT ?s WHERE { VALUES ?s { ${values.map(iri).join(' ')} } GRAPH ${iri(g.union.value)} { ?s rdf:type|rdfs:label ?x } }`).map(r => r.s.value));
}

/**
 * The IRIs of `iris` that are instances (vocabulary.ts isInstance: in the model graph, or a SKOS subject of a shapes graph), in one or
 * two queries. Reason: isInstance reads the store once per data graph and term (§11.3 readBudgetMs).
 */
export function instancesAmong(g: ModelGraph, iris: Iterable<string>): Set<string> {
    const values = [...new Set(iris)].filter(s => s !== g.union.value && s !== UNION_GRAPH);
    const found = inModelAmong(g, values);
    const rest = values.filter(s => !found.has(s)), shapes = g.shapesGraphs();
    if (rest.length && shapes.length) for (const r of rows(g, `SELECT DISTINCT ?s WHERE { VALUES ?s { ${rest.map(iri).join(' ')} }
        GRAPH ?sg { { ?s rdf:type ?t FILTER (?t IN (skos:ConceptScheme, skos:Concept, skos:Collection)) } UNION { ?s skos:inScheme|skos:topConceptOf ?y } }
        FILTER (?sg IN (${shapes.map(t => iri(t.value)).join(', ')})) }`)) found.add(r.s.value);
    return found;
}

/**
 * The home graph of each IRI (vocabulary.ts homeOf: the model graph, or the first shapes graph in order in which it is a SKOS subject),
 * in one or two queries (§11.3 readBudgetMs: homeOf reads the store once per data graph and term).
 */
export function homesAmong(g: ModelGraph, iris: Iterable<string>): Map<string, string> {
    const values = [...new Set(iris)];
    const out = new Map<string, string>();
    if (!values.length) return out;
    const inModel = inModelAmong(g, values);
    const rest = values.filter(s => !inModel.has(s)), shapes = g.shapesGraphs();
    const vocabulary = new Map<string, string>();
    if (rest.length && shapes.length) for (const r of rows(g, `SELECT ?s ?sg WHERE { VALUES ?s { ${rest.map(iri).join(' ')} }
        GRAPH ?sg { { ?s rdf:type ?t FILTER (?t IN (skos:ConceptScheme, skos:Concept, skos:Collection)) } UNION { ?s skos:inScheme|skos:topConceptOf ?y } }
        FILTER (?sg IN (${shapes.map(t => iri(t.value)).join(', ')})) }`)) {
        const was = vocabulary.get(r.s.value);
        if (was === undefined || cmp(r.sg.value, was) < 0) vocabulary.set(r.s.value, r.sg.value);
    }
    for (const s of values) out.set(s, inModel.has(s) ? g.union.value : vocabulary.get(s) ?? g.union.value);
    return out;
}

/**
 * The statements of several terms with their graphs, by term: as subject, and (`objects`) as object for the terms without any as
 * subject (selection.ts statementsOfAll). Not the report graph. Two queries for all terms.
 */
export function statementsByTerm(g: ModelGraph, terms: Iterable<string>, objects = true): Map<string, Quad[]> {
    const values = [...new Set(terms)];
    const out = new Map<string, Quad[]>();
    if (!values.length) return out;
    const read = (list: string[], bound: 's' | 'o') => {
        for (const r of rows(g, `SELECT ?s ?p ?o ?g WHERE { VALUES ?${bound} { ${list.map(iri).join(' ')} } GRAPH ?g { ?s ?p ?o } FILTER (?g != ${NOT_REPORT}) }`)) {
            const key = r[bound].value;
            const quads = out.get(key) ?? [];
            quads.push(rdf.quad(r.s as Quad_Subject, r.p as NamedNode, r.o as Quad_Object, r.g as NamedNode));
            out.set(key, quads);
        }
    };
    read(values, 's');
    const objectsOnly = objects ? values.filter(s => !out.has(s)) : [];
    if (objectsOnly.length) read(objectsOnly, 'o');
    return out;
}
