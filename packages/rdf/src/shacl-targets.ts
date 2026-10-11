// Graph and RDF adapters only. SHACL matching lives in @catenary/shacl/backend.
// The target matches of each node are kept between changes (spec/open.md PERF3, manifest §11.3): a data patch drops the matches of
// the nodes that it can change, and only those are walked again. A shapes change, a new graph or a patch without quads drops all.
import { applicableMatches, focus, readNodeReferences, NodeReference, TargetScope, TargetSelection, iri, term } from '@catenary/shacl/backend';
import type { FocusNode, TargetMatch } from '@catenary/shacl/common';
import type { Quad } from '@rdfjs/types';
import type { Dataset } from 'rdf-ext';
import { GraphChange, ModelGraph, VALIDATION_GRAPH } from './graph';
import { jsonToTerm, rdf, termKey } from './terms';
import { tracer } from './trace';

const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
/** A patch with more quads than this (a load, a file read) drops all kept matches: the walk of the changed nodes costs more. */
const PATCH_LIMIT = 2000;
/** The nodes that a patch can change: more than this, or a walk of more steps, drops all kept matches. */
const AFFECTED_LIMIT = 2000;
const AFFECTED_STEPS = 16;

/**
 * What the target reads keep for one graph. `scope`, `refs` and `byNode` are current except for the nodes in `pending`: the IRIs of the
 * statements that changed since the last read. Undefined `scope` or `refs`: read again.
 */
interface TargetState {
    scope?: TargetScope;
    refs?: NodeReference[];
    /** The predicates of the paths of `refs`, by the direction in which a walk from a focus node to its values follows them. */
    paths?: { forward: string[]; inverse: string[] };
    /**
     * The predicates whose statements can change a match: rdf:type (class targets), the predicates of sh:targetSubjectsOf and
     * sh:targetObjectsOf, and the predicates of the paths. A statement of another predicate changes no match of an IRI node.
     */
    relevant?: Set<string>;
    /** term(node) → the matches of all shapes for that node. */
    byNode: Map<string, TargetMatch[]>;
    /** term(node) → the statements with the node as subject or object (one materialized frontier). */
    frontiers: Map<string, Dataset>;
    pending: Set<string>;
}

const states = new WeakMap<ModelGraph, TargetState>();

const emptyState = (): TargetState => ({ byNode: new Map(), frontiers: new Map(), pending: new Set() });

function reset(s: TargetState): void {
    Object.assign(s, emptyState(), { scope: undefined, refs: undefined, paths: undefined, relevant: undefined });
}

/** A SHACL statement in a data graph: it can change the shapes graphs list or the node references. */
const shaclQuad = (q: Quad) => q.predicate.value.startsWith(SH) || q.object.value === SH + 'NodeShape' || q.object.value === SH + 'PropertyShape';

/** Keep the state in step with a committed patch of the graph. */
function changed(g: ModelGraph, s: TargetState, e: GraphChange): void {
    // Placement geometry, view placements and the report do not change targets (they are outside the data graphs of the scope).
    if (!e.query && !e.shapes) return;
    if (e.shapes || !e.patch.length || e.patch.length > PATCH_LIMIT || !s.scope) return reset(s);
    for (const { quad: q } of e.patch) {
        if (q.graph.value === VALIDATION_GRAPH || g.isView(q.graph)) continue;
        if (!s.scope.data.includes(q.graph.value) || shaclQuad(q)) return reset(s);
        for (const t of [q.subject, q.object]) if (t.termType === 'NamedNode') s.frontiers.delete(iri(t.value));
        // A literal is a focus node too (a value of a path): its frontier has the statements with it as object.
        if (q.object.termType === 'Literal') s.frontiers.delete(literalKey(q.object));
        // Without references nothing is kept yet; a statement of another predicate changes no match.
        if (!s.relevant?.has(q.predicate.value)) continue;
        // A path can pass through a literal (a shared label: rdfs:label / ^rdfs:label). The walk of `affected` follows IRIs only, so a
        // changed literal on a path predicate drops all kept matches.
        if (q.object.termType === 'Literal' && (s.paths?.forward.includes(q.predicate.value) || s.paths?.inverse.includes(q.predicate.value))) {
            s.byNode.clear();
            s.pending.clear();
            continue;
        }
        for (const t of [q.subject, q.object]) if (t.termType === 'NamedNode') s.pending.add(t.value);
    }
}

/** The frontier key (term) of a literal of the store, as the walk names it (focus). */
function literalKey(t: Quad['object']): string {
    try { return term(focus(t as Parameters<typeof focus>[0])); } catch { return ''; }
}

/** The kept state of `g`. Undefined inside a transaction with changes: the store is ahead of the kept state, nothing is kept. */
function stateOf(g: ModelGraph): TargetState | undefined {
    if (g.changes().length) return undefined;
    let s = states.get(g);
    if (!s) {
        const state = s = emptyState();
        states.set(g, s);
        g.onDidChange(e => changed(g, state, e));
    }
    return s;
}

/** The subject's materialized data, if a matching read already built it. */
export function materializedSubject(g: ModelGraph, node: string): Dataset | undefined {
    return stateOf(g)?.frontiers.get(iri(node))?.match(rdf.namedNode(node));
}

/** One generic graph read for all predicates of a bounded set of focus nodes; exclude view and report graphs through the scope. */
function materialize(g: ModelGraph, scope: TargetScope, nodes: readonly FocusNode[], byNode: Map<string, Dataset>): Map<string, Dataset> {
    const pending = nodes.filter(n => !byNode.has(term(n)));
    if (pending.length && scope.data.length) {
        const values = pending.map(term).join(' ');
        const quads = g.construct(`CONSTRUCT { ?s ?p ?o } ${scope.data.map(g => `FROM ${iri(g)}`).join(' ')} WHERE {
            { VALUES ?o { ${values} } ?s ?p ?o }
            UNION { VALUES ?s { ${values} } ?s ?p ?o }
        }`);
        const byTerm = new Map<string, Dataset>();
        for (const node of pending) {
            const dataset = rdf.dataset();
            byNode.set(term(node), dataset);
            byTerm.set(termKey(jsonToTerm(node)), dataset);
        }
        for (const quad of quads) {
            byTerm.get(termKey(quad.subject))?.add(quad);
            if (!quad.subject.equals(quad.object)) byTerm.get(termKey(quad.object))?.add(quad);
        }
    }
    return byNode;
}

function readScope(g: ModelGraph): TargetScope {
    const data = g.select(`SELECT DISTINCT ?g WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER (?g != <${VALIDATION_GRAPH}> && NOT EXISTS { GRAPH ?g { ?view a <osg://vocab/view#View> } })
    }`).map(r => r.g.value);
    const shapes = g.select(`SELECT DISTINCT ?g WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER (?g != <${VALIDATION_GRAPH}> && NOT EXISTS { GRAPH ?g { ?view a <osg://vocab/view#View> } })
        FILTER (STRSTARTS(STR(?p), "http://www.w3.org/ns/shacl#") || ?o IN (<http://www.w3.org/ns/shacl#NodeShape>, <http://www.w3.org/ns/shacl#PropertyShape>))
    }`).map(r => r.g.value);
    return { shapes: [...new Set([...g.shapesGraphs().map(t => t.value), ...shapes])], data };
}

/** Query data can span source graphs. View metadata and validation results are never data. Kept until a patch adds a graph or a SHACL statement. */
export function shapeQueryScope(g: ModelGraph): TargetScope {
    const s = stateOf(g);
    if (!s) return readScope(g);
    return s.scope ??= readScope(g);
}

/** The scope, the node references and the frontiers of a read: kept ones, or new ones inside a transaction. */
function inputs(g: ModelGraph, s: TargetState | undefined): { scope: TargetScope; refs: NodeReference[]; frontiers: Map<string, Dataset> } {
    const scope = tracer.span('shacl', 'scope', () => shapeQueryScope(g));
    const read = () => tracer.span('shacl', 'read node references', () => readNodeReferences(g.store, scope.shapes));
    if (!s) return { scope, refs: read(), frontiers: new Map() };
    if (!s.refs) {
        s.refs = read();
        s.paths = pathPredicates(s.refs);
        const targets = scope.shapes.length ? g.select(`SELECT DISTINCT ?p ${scope.shapes.map(x => `FROM ${iri(x)}`).join(' ')} WHERE {
            ?shape <${SH}targetSubjectsOf>|<${SH}targetObjectsOf> ?p FILTER (isIRI(?p)) }`).map(r => r.p.value) : [];
        s.relevant = new Set([RDF_TYPE, ...targets, ...s.paths.forward, ...s.paths.inverse]);
    }
    return { scope, refs: s.refs, frontiers: s.frontiers };
}

/**
 * The predicates of the paths of the node references. A predicate under `^` is followed from object to subject; a predicate that
 * occurs both ways is in both lists.
 */
function pathPredicates(refs: readonly NodeReference[]): { forward: string[]; inverse: string[] } {
    const forward = new Set<string>(), inverse = new Set<string>();
    for (const { path } of refs) {
        if (!path) continue;
        // The depth of `^(` groups at each position: an odd count of inversions reverses the step.
        const stack: boolean[] = [];
        let inverted = false;
        for (let i = 0; i < path.length; i++) {
            const c = path[i];
            if (c === '<') {
                const end = path.indexOf('>', i);
                (inverted ? inverse : forward).add(path.slice(i + 1, end));
                i = end;
            } else if (c === '(') { stack.push(inverted); if (path[i - 1] === '^') inverted = !inverted; }
            else if (c === ')') inverted = stack.pop() ?? false;
            else if (c === '^' && path[i + 1] === '<') {
                const end = path.indexOf('>', i);
                (inverted ? forward : inverse).add(path.slice(i + 2, end));
                i = end;
            }
        }
    }
    return { forward: [...forward], inverse: [...inverse] };
}

/**
 * The nodes whose matches the changed IRIs can change. A node matches a shape through a direct target, or through a walk from a focus
 * node along the paths of the node references to it. A change of a statement changes the direct targets of its ends, and the walks
 * through its ends, so the nodes that the paths reach from an end, step by step. Undefined: too many to walk.
 */
function affected(g: ModelGraph, scope: TargetScope, paths: { forward: string[]; inverse: string[] }, changed: readonly string[]): string[] | undefined {
    const seen = new Set(changed);
    if (!paths.forward.length && !paths.inverse.length || !scope.data.length) return [...seen];
    const from = scope.data.map(d => `FROM ${iri(d)}`).join(' ');
    const steps = [
        ...paths.forward.length ? [`{ VALUES ?p { ${paths.forward.map(iri).join(' ')} } ?n ?p ?x }`] : [],
        ...paths.inverse.length ? [`{ VALUES ?p { ${paths.inverse.map(iri).join(' ')} } ?x ?p ?n }`] : []
    ].join(' UNION ');
    let frontier = [...seen];
    for (let step = 0; frontier.length; step++) {
        if (step >= AFFECTED_STEPS) return undefined;
        const next: string[] = [];
        for (const r of g.select(`SELECT DISTINCT ?x ${from} WHERE { VALUES ?n { ${frontier.map(iri).join(' ')} } ${steps} }`)) {
            // A path can pass through a literal (a shared label: rdfs:label / ^rdfs:label): the nodes behind it are not walked here, so
            // all kept matches drop.
            if (r.x.termType !== 'NamedNode') return undefined;
            if (!seen.has(r.x.value)) { seen.add(r.x.value); next.push(r.x.value); }
        }
        if (seen.size > AFFECTED_LIMIT) return undefined;
        frontier = next;
    }
    return [...seen];
}

/** Drop the kept matches of the nodes that the pending changes can change. */
function sync(g: ModelGraph, s: TargetState, scope: TargetScope): void {
    if (!s.pending.size) return;
    const changed = [...s.pending];
    s.pending.clear();
    const nodes = tracer.span('shacl', 'affected nodes', () => {
        const nodes = affected(g, scope, s.paths ?? { forward: [], inverse: [] }, changed);
        tracer.note(`changed ${changed.length}; affected ${nodes?.length ?? 'all'}`);
        return nodes;
    });
    if (!nodes) s.byNode.clear();
    else for (const n of nodes) s.byNode.delete(iri(n));
}

/** The order of applicableMatches (localeCompare of the shape, then of the node as JSON), with the JSON of each node built once. */
const collator = new Intl.Collator();
function sortMatches(matches: TargetMatch[]): TargetMatch[] {
    const keyed = matches.map(m => ({ m, node: JSON.stringify(m.node) }));
    keyed.sort((a, b) => collator.compare(a.m.shape, b.m.shape) || collator.compare(a.node, b.node));
    return keyed.map(k => k.m);
}

/**
 * The shapes that apply to the nodes of `selection`, or the nodes that the shapes of `selection` apply to (applicableMatches). With
 * nodes, the matches of each IRI node are kept until a change can change them: the result of a node does not depend on the other
 * nodes of the selection, and with shapes it is the matches of all shapes, filtered.
 */
export function shapeTargetMatches(g: ModelGraph, selection: TargetSelection): TargetMatch[] {
    return tracer.span('shacl', 'target matches', () => {
        const s = stateOf(g);
        const { scope, refs, frontiers } = inputs(g, s);
        const note = (more = '') => { if (tracer.on) tracer.note(`references ${refs.length} refs; ${scope.shapes.length} shapes graphs; ${scope.data.length} data graphs${more}`); };
        const port = {
            select: (q: string) => g.select(q),
            traverse: (nodes: readonly FocusNode[], predicates: readonly string[], reverse: boolean, graphs: readonly string[]) => {
                // The kept frontiers are of the data graphs of the scope; a read of other graphs builds its own.
                const kept = graphs.length === scope.data.length && graphs.every(d => scope.data.includes(d)) ? frontiers : new Map<string, Dataset>();
                const datasets = materialize(g, { ...scope, data: graphs }, nodes, kept), out: { node: FocusNode; predicate: string; value: FocusNode }[] = [];
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
        const walk = (sel: TargetSelection) => tracer.span('shacl', 'walk', () => {
            if (tracer.on) tracer.note(`nodes ${sel.nodes?.length ?? 'all'}; shapes ${sel.shapes?.length ?? 'all'}`);
            return applicableMatches(port, scope, refs, sel);
        });
        if (!s || !selection.nodes || selection.nodes.length === 0 || selection.shapes?.length === 0) { note(); return walk(selection); }
        sync(g, s, scope);
        const nodes = new Map(selection.nodes.map(n => [term(n), n]));
        const iris = [...nodes].filter(([, n]) => n.termType === 'NamedNode');
        const missing = iris.filter(([k]) => !s.byNode.has(k)).map(([, n]) => n);
        note(`; nodes ${nodes.size}, kept ${iris.length - missing.length}, walked ${missing.length}`);
        if (missing.length) {
            for (const n of missing) s.byNode.set(term(n), []);
            for (const m of walk({ nodes: missing })) s.byNode.get(term(m.node))?.push(m);
        }
        const literals = [...nodes.values()].filter(n => n.termType !== 'NamedNode');
        const shapes = selection.shapes && new Set(selection.shapes);
        const out = iris.flatMap(([k]) => s.byNode.get(k) ?? []).filter(m => !shapes || shapes.has(m.shape));
        if (literals.length) out.push(...walk({ ...selection, nodes: literals }));
        return sortMatches(out);
    });
}
