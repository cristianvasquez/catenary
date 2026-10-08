// Graph and RDF adapters only. SHACL matching lives in @catenary/shacl/backend.
import { applicableMatches, readNodeReferences, NodeReference, TargetScope, TargetSelection } from '@catenary/shacl/backend';
import type { TargetMatch } from '@catenary/shacl/common';
import { ModelGraph, VALIDATION_GRAPH } from './graph';

const references = new WeakMap<ModelGraph, { revision: number; refs: NodeReference[] }>();

/** Query data can span source graphs. View metadata and validation results are never data. */
export function shapeQueryScope(g: ModelGraph): TargetScope {
    const data = g.store.select(`SELECT DISTINCT ?g WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER (?g != <${VALIDATION_GRAPH}> && NOT EXISTS { GRAPH ?g { ?view a <osg://vocab/view#View> } })
    }`).map(r => r.g.value);
    const shapes = g.store.select(`SELECT DISTINCT ?g WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER (?g != <${VALIDATION_GRAPH}> && NOT EXISTS { GRAPH ?g { ?view a <osg://vocab/view#View> } })
        FILTER (STRSTARTS(STR(?p), "http://www.w3.org/ns/shacl#") || ?o IN (<http://www.w3.org/ns/shacl#NodeShape>, <http://www.w3.org/ns/shacl#PropertyShape>))
    }`).map(r => r.g.value);
    return { shapes: [...new Set([...g.shapesGraphs().map(t => t.value), ...shapes])], data };
}

export function shapeTargetMatches(g: ModelGraph, selection: TargetSelection): TargetMatch[] {
    const scope = shapeQueryScope(g);
    const cacheable = scope.shapes.every(graph => g.shapesGraphs().some(t => t.value === graph));
    let cached = references.get(g);
    if (!cacheable || !cached || cached.revision !== g.shapesRevision) {
        cached = { revision: g.shapesRevision, refs: readNodeReferences(g.store, scope.shapes) };
        if (cacheable) references.set(g, cached);
    }
    return applicableMatches(g.store, scope, cached.refs, selection);
}
