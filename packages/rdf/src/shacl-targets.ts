// Graph and RDF adapters only. SHACL matching lives in @catenary/shacl/backend.
import { applicableMatches, readNodeReferences, NodeReference, TargetScope, TargetSelection, iri, term } from '@catenary/shacl/backend';
import type { FocusNode, TargetMatch } from '@catenary/shacl/common';
import type { Dataset } from 'rdf-ext';
import { GraphChange, ModelGraph, VALIDATION_GRAPH } from './graph';
import { IndexedStore } from './notations';
import { jsonToTerm, rdf, termKey } from './terms';
import { tracer } from './trace';

const references = new WeakMap<ModelGraph, { event: GraphChange; refs: NodeReference[] }>();
const scopes = new WeakMap<ModelGraph, { event: GraphChange; scope: TargetScope }>();
const frontiers = new WeakMap<ModelGraph, { event: GraphChange; byNode: Map<string, Dataset> }>();

/** The subject's materialized data, if a matching read already built it. */
export function materializedSubject(g: ModelGraph, node: string): Dataset | undefined {
    const entry = frontiers.get(g);
    return entry?.event === g.keys.query ? entry.byNode.get(iri(node))?.match(rdf.namedNode(node)) : undefined;
}

/** One generic graph read for all predicates of a bounded set of focus nodes; exclude view and report graphs through the scope. */
function materialize(g: ModelGraph, scope: TargetScope, nodes: readonly FocusNode[]): Map<string, Dataset> {
    const version = g.keys.query;
    let cached = frontiers.get(g);
    if (!cached || cached.event !== version) {
        cached = { event: version, byNode: new Map() };
        frontiers.set(g, cached);
    }
    const pending = nodes.filter(n => !cached!.byNode.has(term(n)));
    if (pending.length && scope.data.length) {
        const values = pending.map(term).join(' ');
        const quads = g.construct(`CONSTRUCT { ?s ?p ?o } ${scope.data.map(g => `FROM ${iri(g)}`).join(' ')} WHERE {
            { VALUES ?o { ${values} } ?s ?p ?o }
            UNION { VALUES ?s { ${values} } ?s ?p ?o }
        }`);
        const byTerm = new Map<string, Dataset>();
        for (const node of pending) {
            const dataset = rdf.dataset();
            cached.byNode.set(term(node), dataset);
            byTerm.set(termKey(jsonToTerm(node)), dataset);
        }
        for (const quad of quads) {
            byTerm.get(termKey(quad.subject))?.add(quad);
            if (!quad.subject.equals(quad.object)) byTerm.get(termKey(quad.object))?.add(quad);
        }
    }
    return cached.byNode;
}

/** Query data can span source graphs. View metadata and validation results are never data. */
export function shapeQueryScope(g: ModelGraph): TargetScope {
    const version = g.keys.query;
    const cached = scopes.get(g);
    if (cached && cached.event === version) return cached.scope;
    const data = g.select(`SELECT DISTINCT ?g WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER (?g != <${VALIDATION_GRAPH}> && NOT EXISTS { GRAPH ?g { ?view a <osg://vocab/view#View> } })
    }`).map(r => r.g.value);
    const shapes = g.select(`SELECT DISTINCT ?g WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER (?g != <${VALIDATION_GRAPH}> && NOT EXISTS { GRAPH ?g { ?view a <osg://vocab/view#View> } })
        FILTER (STRSTARTS(STR(?p), "http://www.w3.org/ns/shacl#") || ?o IN (<http://www.w3.org/ns/shacl#NodeShape>, <http://www.w3.org/ns/shacl#PropertyShape>))
    }`).map(r => r.g.value);
    const scope = { shapes: [...new Set([...g.shapesGraphs().map(t => t.value), ...shapes])], data };
    scopes.set(g, { event: version, scope });
    return scope;
}

export function shapeTargetMatches(g: ModelGraph, selection: TargetSelection): TargetMatch[] {
    return tracer.span('shacl', 'target matches', () => {
        const scope = tracer.span('shacl', 'scope', () => shapeQueryScope(g));
        const version = g.keys.query;
        const cacheable = g.store instanceof IndexedStore || scope.shapes.every(graph => g.shapesGraphs().some(t => t.value === graph));
        let cached = references.get(g);
        if (!cacheable || !cached || cached.event !== version) {
            cached = { event: version, refs: tracer.span('shacl', 'read node references', () => readNodeReferences(g.store, scope.shapes)) };
            if (cacheable) references.set(g, cached);
        }
        if (tracer.on) tracer.note(`references ${cacheable ? 'cacheable' : 'uncacheable'}; ${cached.refs.length} refs; ${scope.shapes.length} shapes graphs; ${scope.data.length} data graphs`);
        const port = {
            select: (q: string) => g.select(q),
            traverse: (nodes: readonly FocusNode[], predicates: readonly string[], reverse: boolean, graphs: readonly string[]) => {
                const datasets = materialize(g, { ...scope, data: graphs }, nodes), out: { node: FocusNode; predicate: string; value: FocusNode }[] = [];
                for (const node of nodes) {
                    const dataset = datasets.get(term(node));
                    if (!dataset) continue;
                    const ptr = rdf.grapoi({ dataset, term: jsonToTerm(node) });
                    for (const predicate of predicates) for (const value of (reverse ? ptr.in(rdf.namedNode(predicate)) : ptr.out(rdf.namedNode(predicate))).terms)
                        if (value.termType === 'NamedNode' || value.termType === 'Literal') out.push({ node, predicate, value: { termType: value.termType, value: value.value,
                            ...(value.termType === 'Literal' && value.language ? { language: value.language } : {}),
                            ...(value.termType === 'Literal' && !value.language && value.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string' ? { datatype: value.datatype.value } : {}) } });
                }
                return out;
            }
        };
        return tracer.span('shacl', 'walk', () => applicableMatches(port, scope, cached.refs, selection));
    });
}
