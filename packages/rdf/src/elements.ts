// Operations on any element of the model, whatever its kind: instance, relation, view, node shape, property shape, logical
// constraint, value set, concept. One rule for each operation; the kind decides only the default label predicate.

import { labelProblem } from '@catenary/model';
import type { NamedNode } from '@rdfjs/types';
import { ModelGraph, P } from './graph';
import { elementTerm } from './ids';
import * as ops from './ops';
import { S } from './shapes-read';
import * as shapes from './shape-ops';
import { rdf } from './terms';

const { ok, fail, gone } = ops;

/** The subject that carries the label of an element, and the predicate and graph for a first label. */
function labelTarget(g: ModelGraph, id: string): { s: NamedNode; predicate: NamedNode; graph: NamedNode; concept?: boolean } | undefined {
    const view = ops.viewTerm(g, id);
    if (view) return { s: g.viewSubject(view) as NamedNode, predicate: P.label, graph: view };
    const instance = ops.instanceTerm(g, id);
    if (instance) return { s: instance, predicate: P.label, graph: g.homeOf(instance) };
    const idx = shapes.shapesIndex(g);
    const shape = idx.nodeShape.get(id);
    if (shape) return { s: shape.term, predicate: S.name, graph: shape.graph };
    const set = idx.valueSet.get(id);
    if (set) return { s: set.term, predicate: S.prefLabel, graph: set.graph };
    // A concept that is only a row of its scheme or collection (no statements of its own): it becomes a skos:Concept with
    // skos:prefLabel in the graph of that value set (the read model takes SKOS statements of typed subjects only).
    const t = elementTerm(id);
    const container = t && Object.values(idx.model.valueSets).find(v => v.members.some(m => m.uri === t.value));
    if (t && container) return { s: t, predicate: S.prefLabel, graph: idx.valueSet.get(container.id)!.graph, concept: true };
    return undefined;
}

/** Rename an element: instance, view, node shape, value set or concept. */
export function renameElement(g: ModelGraph, id: string, label: string): ops.Result {
    const target = labelTarget(g, id);
    if (!target) return gone('element', id);
    const problem = labelProblem(label);
    if (problem) return fail(problem);
    if (target.concept && !g.match(target.s, null, null, target.graph).length) g.add(target.s, P.type, S.Concept, target.graph);
    ops.writeLabel(g, target.s, rdf.literal(label), target);
    return ok(undefined);
}

/**
 * Delete elements of any kind in one step: node shapes (with their property shapes and cards), property shapes, logical constraints
 * (dissolved), value sets that no property uses, instances and relations (from the model and all views), views (with the references to
 * them). A shape wins over an instance with the same IRI, as for cards.
 */
export function deleteElements(g: ModelGraph, ids: string[]): ops.Result {
    const idx = shapes.shapesIndex(g);
    const shapeIds = ids.filter(id => idx.nodeShape.has(id) || idx.property.has(id) || idx.constraint.has(id));
    const sets = ids.filter(id => !idx.nodeShape.has(id) && idx.valueSet.has(id));
    const rest = ids.filter(id => !shapeIds.includes(id) && !sets.includes(id));
    const instances = rest.filter(id => ops.instanceTerm(g, id));
    const relations = rest.filter(id => ops.relationTerms(g, id));
    const views = rest.filter(id => ops.viewTerm(g, id));
    if (!shapeIds.length && !sets.length && !instances.length && !relations.length && !views.length) return fail('Nothing to delete.');
    if (shapeIds.length) {
        const r = shapes.deleteShapes(g, shapeIds);
        if (!r.ok) return r;
    }
    for (const id of sets) {
        const r = shapes.deleteValueSet(g, id);
        if (!r.ok) return r;
    }
    // A relation id is its triple: it stays valid when an instance of it is deleted first (then the delete does nothing).
    for (const id of instances) ops.deleteInstance(g, id);
    for (const id of relations) ops.deleteRelation(g, id);
    for (const id of views) ops.deleteView(g, id);
    return ok(undefined);
}
