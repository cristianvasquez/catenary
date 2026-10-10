// Moved ids (ModelSnapshot.movedIds): the elements whose IRI a change replaced. For each kind (views, instances, node shapes, property
// shapes, logical constraints, value sets), one id gone and one id new is a change of the IRI. Only the terms of the patch can change
// kind, so the store compares the state before and after the patch for these terms, not for all elements.

import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { Change, MODEL_GRAPH, ModelGraph, P, SKOS_MEMBERSHIP, SKOS_TYPES, V } from './graph';
import { elementId } from './ids';
import type { ShapesIndex } from './shapes-read';
import { rdf, termKey, tripleKey } from './terms';

const quadKey = (q: Quad) => `${tripleKey(q)} ${termKey(q.graph)}`;
const matches = (q: Quad, s?: Term | null, p?: Term | null, o?: Term | null, g?: Term | null) =>
    (!s || q.subject.equals(s)) && (!p || q.predicate.equals(p)) && (!o || q.object.equals(o)) && (!g || q.graph.equals(g));

/**
 * `match` on the dataset before `patch` (the changes in the order applied, already applied to `g`). A quad whose first change is an
 * add was not there before; a quad whose first change is a remove was there.
 */
export function matchBefore(g: ModelGraph, patch: readonly Change[]): (s?: Term | null, p?: Term | null, o?: Term | null, graph?: Term | null) => Quad[] {
    const first = new Map<string, Change>();
    for (const c of patch) if (!first.has(quadKey(c.quad))) first.set(quadKey(c.quad), c);
    const removed = [...first.values()].filter(c => c.op === 'remove').map(c => c.quad);
    return (s, p, o, graph) => {
        const union = graph?.equals(g.model);
        const matchesGraph = (q: Quad) => !graph || (union ? g.isDataGraph(q.graph) : q.graph.equals(graph));
        const found = [
            ...g.match(s, p, o).filter(q => matchesGraph(q) && first.get(quadKey(q))?.op !== 'add'),
            ...removed.filter(q => matchesGraph(q) && matches(q, s, p, o))
        ];
        return union ? [...new Map(found.map(q => [tripleKey(q), rdf.quad(q.subject, q.predicate, q.object, g.model)])).values()] : found;
    };
}

/** Old id -> new id of the elements whose IRI `patch` changed. `shapes`: the shapes index before and after the patch. */
export function movedIds(g: ModelGraph, patch: readonly Change[], shapes?: { before: ShapesIndex; after: ShapesIndex }): Record<string, string> {
    const was = matchBefore(g, patch);
    const moved: Record<string, string> = {};
    const compare = (before: Iterable<string>, after: Iterable<string>) => {
        const old = new Set(before), now = new Set(after);
        const gone = [...old].filter(id => !now.has(id)), added = [...now].filter(id => !old.has(id));
        if (gone.length === 1 && added.length === 1) moved[gone[0]] = added[0];
    };
    const isInstanceIn = (match: typeof was) => (t: NamedNode) => t.value !== MODEL_GRAPH && !t.equals(g.model) && (
        match(t, P.type, null, g.model).length > 0 || match(t, P.label, null, g.model).length > 0
        || [...SKOS_TYPES.flatMap(type => match(t, P.type, type)), ...SKOS_MEMBERSHIP.flatMap(p => match(t, p))].some(q => g.isShapesGraph(q.graph)));
    const isViewIn = (match: typeof was) => (t: NamedNode) => !t.equals(g.model) && match(null, P.type, V.View, t).length > 0;

    const subjects = new Map<string, NamedNode>(), graphs = new Map<string, NamedNode>();
    for (const { quad: q } of patch) {
        if (q.subject.termType === 'NamedNode' && (g.isDataGraph(q.graph) || g.isShapesGraph(q.graph))) subjects.set(q.subject.value, q.subject);
        else if (q.graph.termType === 'NamedNode' && !g.isDataGraph(q.graph) && !g.isShapesGraph(q.graph)) graphs.set(q.graph.value, q.graph);
    }
    const now = g.match.bind(g) as typeof was;
    const ids = (terms: Iterable<NamedNode>, test: (t: NamedNode) => boolean) => [...terms].filter(test).map(elementId);
    compare(ids(graphs.values(), isViewIn(was)), ids(graphs.values(), isViewIn(now)));
    compare(ids(subjects.values(), isInstanceIn(was)), ids(subjects.values(), isInstanceIn(now)));
    if (shapes) for (const k of ['nodeShapes', 'properties', 'constraints', 'valueSets'] as const) {
        compare(Object.keys(shapes.before.model[k]), Object.keys(shapes.after.model[k]));
    }
    return moved;
}
