// The Search panel and Find Element: a faceted search by SPARQL (@catenary/model search.ts). One query gives the things of the facets,
// one query counts the things of each type, and with "linked to" one query counts the things of each relation type. A count applies
// the other facets, not its own. Labels come from `labels` (sparql.ts), the views from the placements of the view graphs.

import type { NamedNode, Quad } from '@rdfjs/types';
import { FacetCount, NS, SearchFacets, SearchHit, SearchResult, searchKind } from '@catenary/model';
import { ModelGraph } from './graph';
import { elementId, elementTerm } from './ids';
import type { ShapesIndex } from './shapes-read';
import { NOT_REPORT, PREDICATES, PROPERTY_SHAPES, compareLabels, construct, iri, labels, rows, str, things } from './sparql';
import { rdf, termKey } from './terms';

export interface SearchContext {
    g: ModelGraph;
    /** For the ids and owners of the property shapes (an id of a property shape is not its IRI, ids.ts). */
    shapes: ShapesIndex;
}

/** The facets as IRIs and lower-case words. */
interface Facets {
    words: string[];
    type?: string;
    linkedTo?: string;
    predicate?: string;
    direction?: 'out' | 'in';
}

/** The things (binds ?s ?type ?g): `things`, the property shapes, the predicates in use. Not the report graph. */
const THINGS = `{ ${things()} } UNION ${PROPERTY_SHAPES} UNION ${PREDICATES} FILTER (?g != ${NOT_REPORT})`;

/** The "linked to" pattern: binds ?outP (X ?outP ?s) or ?inP (?s ?inP X), and ?direction ?predicate. */
function linkPattern(X: string, f: Pick<Facets, 'predicate' | 'direction'>): string {
    const P = f.predicate ? ` && ?predicate = ${iri(f.predicate)}` : '';
    const out = `{ GRAPH ?gl { ${X} ?outP ?s } BIND (?outP AS ?predicate) BIND ("out" AS ?direction) FILTER (?gl != ${NOT_REPORT} && ?outP != rdf:type${P}) }`;
    const into = `{ GRAPH ?gl { ?s ?inP ${X} } BIND (?inP AS ?predicate) BIND ("in" AS ?direction) FILTER (?gl != ${NOT_REPORT}${P}) }`;
    return f.direction === 'out' ? out : f.direction === 'in' ? into : `${out} UNION ${into}`;
}

/** Each word is in the local name of the IRI of ?s or in a literal of ?s. */
const wordFilter = (w: string, i: number) => `FILTER (CONTAINS(LCASE(REPLACE(STR(?s), "^.*[#/:]", "")), ${str(w)})
        || EXISTS { GRAPH ?gv${i} { ?s ?p${i} ?v${i} } FILTER (?gv${i} != ${NOT_REPORT} && isLiteral(?v${i}) && CONTAINS(LCASE(STR(?v${i})), ${str(w)})) })`;

/** The facets of `f` as patterns; `omit` leaves out a facet (its own count). */
function facetPatterns(f: Facets, omit?: 'type' | 'link'): string {
    return [
        f.type && omit !== 'type' ? `FILTER (?type = ${iri(f.type)})` : '',
        f.linkedTo ? linkPattern(iri(f.linkedTo), omit === 'link' ? {} : f) : '',
        ...f.words.map(wordFilter)
    ].filter(Boolean).join('\n        ');
}

/**
 * The things that match every facet (CONSTRUCT): `?s rdf:type ?type` for each, and with `linkedTo` the statement that links it.
 * At most `limit` + 1 things in IRI order (the order only makes the cut stable).
 */
export function facetedSearch(g: ModelGraph, f: Facets, limit: number): Quad[] {
    const X = f.linkedTo ? iri(f.linkedTo) : '?noX';
    return construct(g, `CONSTRUCT {
        ?s rdf:type ?type .
        ${X} ?outP ?s .
        ?s ?inP ${X} .
    } WHERE {
        { SELECT DISTINCT ?s WHERE { ${THINGS} ${facetPatterns(f)} } ORDER BY STR(?s) LIMIT ${limit + 1} }
        ${THINGS}
        ${facetPatterns(f)}
    }`);
}

/** The number of things of each type, with the other facets. */
export function typeCounts(g: ModelGraph, f: Facets): FacetCount<string>[] {
    return rows(g, `SELECT ?type (COUNT(DISTINCT ?s) AS ?n) WHERE {
        ${THINGS}
        ${facetPatterns(f, 'type')}
    } GROUP BY ?type ORDER BY DESC(?n) STR(?type)`).map(r => ({ value: r.type.value, count: Number(r.n.value) }));
}

/** With `linkedTo`: the number of things for each relation type (direction, predicate), with the other facets. */
export function linkCounts(g: ModelGraph, f: Facets): FacetCount<{ direction: 'out' | 'in'; predicate: string }>[] {
    if (!f.linkedTo) return [];
    return rows(g, `SELECT ?direction ?predicate (COUNT(DISTINCT ?s) AS ?n) WHERE {
        ${THINGS}
        ${facetPatterns(f, 'link')}
    } GROUP BY ?direction ?predicate ORDER BY DESC(?n) ?direction STR(?predicate)`)
        .map(r => ({ value: { direction: r.direction.value as 'out' | 'in', predicate: r.predicate.value }, count: Number(r.n.value) }));
}

/** The views that place each IRI (a view graph with a placement of it). */
function viewsOf(g: ModelGraph, iris: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (!iris.length) return out;
    for (const r of rows(g, `SELECT DISTINCT ?e ?v WHERE {
            VALUES ?e { ${iris.map(iri).join(' ')} }
            GRAPH ?v { ?pl view:element ?e . ?v a view:View }
        } ORDER BY STR(?v)`)) out.set(r.e.value, [...(out.get(r.e.value) ?? []), elementId(r.v as NamedNode)]);
    return out;
}

/** The things that match the facets, sorted by label: the first `limit`, the counts of the facet values, the "linked to" element. */
export function search(ctx: SearchContext, facets: SearchFacets, limit: number): SearchResult {
    const { g, shapes } = ctx;
    const X = facets.linkedTo ? elementTerm(facets.linkedTo) : undefined;
    if (facets.linkedTo && !X) return { hits: [], more: false, types: [] };
    const f: Facets = {
        words: (facets.text ?? '').toLowerCase().split(/\s+/).filter(Boolean),
        type: facets.type, linkedTo: X?.value, predicate: facets.predicate, direction: facets.direction
    };
    // "linked to" an element with no statement: the facet is gone (the panel removes it).
    if (X && !rows(g, `SELECT ?p WHERE { GRAPH ?g { ${iri(X.value)} ?p ?o } FILTER (?g != ${NOT_REPORT}) } LIMIT 1`).length) {
        return { hits: [], more: false, types: [] };
    }

    const quads = facetedSearch(g, f, limit);
    const types = new Map<string, string[]>();
    for (const q of quads) if (q.predicate.value === NS.rdf + 'type') types.set(q.subject.value, [...(types.get(q.subject.value) ?? []), q.object.value]);
    const names = labels(g, [...types.keys(), ...(X ? [X.value] : [])]);
    const all = [...types].map(([s, ts]): SearchHit => {
        const own = ts.filter(t => t !== NS.rdfs + 'Resource').sort();
        const kind = searchKind(own);
        // A property shape: its id and node shape come from the shapes index (ids.ts).
        const pid = kind === 'property' ? shapes.byTerm.get(termKey(rdf.namedNode(s))) : undefined;
        const owner = pid ? shapes.model.properties[pid]?.owner : undefined;
        return { id: pid ?? elementId(rdf.namedNode(s)), kind, label: names.get(s)!, iri: s, types: own, ...(owner ? { owner } : {}), views: [] };
    }).sort((a, b) => compareLabels(a.label, b.label) || a.iri.localeCompare(b.iri));
    const hits = all.slice(0, limit);
    // The card that a view shows: the thing, or the node shape of a property shape.
    const cardIri = (h: SearchHit) => h.owner ? elementTerm(h.owner)?.value : h.iri;
    const views = viewsOf(g, [...new Set(hits.map(cardIri).filter((x): x is string => !!x))]);
    for (const h of hits) h.views = views.get(cardIri(h) ?? '') ?? [];

    return {
        hits, more: all.length > limit, types: typeCounts(g, f),
        linked: X ? { id: facets.linkedTo!, label: names.get(X.value)!, iri: X.value, links: linkCounts(g, f) } : undefined
    };
}
