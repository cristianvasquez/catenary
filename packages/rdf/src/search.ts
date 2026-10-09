// Find Element: the things of the store by SPARQL (@catenary/model search.ts), sorted by label. Labels come from `labels` (sparql.ts),
// the views from the placements of the view graphs.

import type { NamedNode } from '@rdfjs/types';
import { NS, SearchHit, searchKind } from '@catenary/model';
import { ModelGraph } from './graph';
import { elementId, elementTerm } from './ids';
import type { ShapesIndex } from './shapes-read';
import { NOT_REPORT, PROPERTY_SHAPES, compareLabels, iri, labels, rows, things } from './sparql';
import { rdf, termKey } from './terms';

export interface SearchContext {
    g: ModelGraph;
    /** For the ids and owners of the property shapes (an id of a property shape is not its IRI, ids.ts). */
    shapes: ShapesIndex;
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

/** The things (`things` and the property shapes, not the report graph, not the predicates), sorted by label. */
export function search(ctx: SearchContext): SearchHit[] {
    const { g, shapes } = ctx;
    const types = new Map<string, string[]>();
    for (const r of rows(g, `SELECT DISTINCT ?s ?type WHERE { { ${things()} } UNION ${PROPERTY_SHAPES} FILTER (?g != ${NOT_REPORT}) }`)) {
        types.set(r.s.value, [...(types.get(r.s.value) ?? []), r.type.value]);
    }
    const names = labels(g, [...types.keys()]);
    const hits = [...types].flatMap(([s, ts]): SearchHit[] => {
        const own = ts.filter(t => t !== NS.rdfs + 'Resource').sort();
        const kind = searchKind(own);
        if (!kind) return [];
        // A property shape: its id and node shape come from the shapes index (ids.ts).
        const pid = kind === 'property' ? shapes.byTerm.get(termKey(rdf.namedNode(s))) : undefined;
        const owner = pid ? shapes.model.properties[pid]?.owner : undefined;
        return [{ id: pid ?? elementId(rdf.namedNode(s)), kind, label: names.get(s)!, iri: s, types: own, ...(owner ? { owner } : {}), views: [] }];
    }).sort((a, b) => compareLabels(a.label, b.label) || a.iri.localeCompare(b.iri));
    // The card that a view shows: the thing, or the node shape of a property shape.
    const cardIri = (h: SearchHit) => h.owner ? elementTerm(h.owner)?.value : h.iri;
    const views = viewsOf(g, [...new Set(hits.map(cardIri).filter((x): x is string => !!x))]);
    for (const h of hits) h.views = views.get(cardIri(h) ?? '') ?? [];
    return hits;
}
