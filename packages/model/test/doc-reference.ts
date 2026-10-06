// Rules on the read model of the whole dataset (a Doc), for tests only. ADR 0012: the application builds request-scoped read models
// and answers these questions by SPARQL (packages/rdf); the tests compare its answers, and the diagram rules, with these references.

import {
    Classes, Description, Doc, ElementKind, Instance, ModelSelection, NS, Selected, TermJSON, View, boxes, boxShowing, elementOfId, hasEnds, inView, kindOf,
    placementOfId, shapeElementInView
} from '../src';

const LABEL = NS.rdfs + 'label';

/** The selection `s` on the read model: ids of deleted elements go; the view goes when it does not exist. */
export function resolveSelection(doc: Doc, s: ModelSelection): Selected {
    const view = s.view && doc.views[s.view] ? s.view : undefined;
    const stored = view ? doc.views[view] : undefined;
    const ids = [...new Set(s.ids)].filter(id => kindOf(doc, stored, id) !== undefined);
    const elements = [...new Set(ids.map(id => elementOfId(stored, id)))];
    const kinds = elements.map(id => ({ id, kind: kindOf(doc, stored, id) }));
    const of = (kind: ElementKind) => kinds.filter(x => x.kind === kind).map(x => x.id);
    return { view, ids, elements, instances: of('instance'), relations: of('relation'), views: of('view'), groups: of('group'), notes: of('note'),
        references: of('reference'), collections: of('collection'), arrows: of('arrow'), shapes: of('shape'), properties: of('property'),
        constraints: of('constraint'), valueSets: of('valueSet') };
}

/**
 * The diagram ids of the part of a selection that the view `viewId` shows: the placements in it of the instances and relations
 * that it shows (also when another view selected them), and its groups, notes, view references and collections if the
 * selection was made in it. The rule that a view editor applies on its diagram graph (selectionInDiagram, diagram-ids.ts).
 */
export function selectionInView(doc: Doc, s: ModelSelection, viewId: string): string[] {
    const stored = doc.views[viewId];
    if (!stored) return [];
    const view = stored;
    const selectedView = s.view ? doc.views[s.view] : undefined;
    const ids = s.view === viewId ? s.ids.map(id => elementOfId(view, id)) : [...new Set(s.ids.map(id => elementOfId(selectedView, id)))];
    return [...new Set(ids.filter(id => {
        const kind = kindOf(doc, view, id);
        if (kind === 'instance') return inView(view, id);
        if (kind === 'relation') return hasEnds(view, doc.relations[id]);
        if (kind === 'shape' || kind === 'property' || kind === 'constraint') return shapeElementInView(doc, view, id);
        return kind !== undefined && kind !== 'view' && s.view === viewId;
    }).map(id => placementOfId(view, id)))];
}

/** For each instance: the number of instances of `hiddenNeighbors` 'in' and 'out' in `view`. One pass over the relations. */
export function hiddenNeighborCounts(doc: Doc, view: View | undefined): Map<string, { in: number; out: number }> {
    const shown = new Map<string, boolean>();
    const isShown = (id: string) => {
        let v = shown.get(id);
        if (v === undefined) shown.set(id, v = boxShowing(doc, view, id) !== undefined);
        return v;
    };
    const others = new Map<string, { in: Set<string>; out: Set<string> }>();
    for (const r of Object.values(doc.relations)) {
        for (const [dir, self, other] of [['out', r.subject, r.object], ['in', r.object, r.subject]] as const) {
            if (other === self || !doc.instances[other] || isShown(other)) continue;
            let o = others.get(self);
            if (!o) others.set(self, o = { in: new Set(), out: new Set() });
            o[dir].add(other);
        }
    }
    return new Map([...others].map(([id, o]) => [id, { in: o.in.size, out: o.out.size }]));
}

/** Relations with no placement (a placed edge) in any view. A hidden edge has none. */
export function unplacedRelations(doc: Doc): string[] {
    const placed = new Set(Object.values(doc.views).flatMap(v => v.edges.filter(e => e.id).map(e => e.relation)));
    return Object.keys(doc.relations).filter(id => !placed.has(id));
}

/** Instances with no placement (a card) in any view. A concept shown only as a row of a scheme or collection card has none. */
export function unplacedInstances(doc: Doc): string[] {
    const placed = new Set(Object.values(doc.views).flatMap(v => boxes(v, 'card').map(c => c.element)));
    return Object.keys(doc.instances).filter(id => !placed.has(id));
}

/** The classes of the shapes and the types of the instances: what a typed class name resolves to (`classIri`). */
export function knownClasses(doc: Doc, meta: Classes): { iri: string; name?: string }[] {
    const types = new Set(Object.values(doc.instances).flatMap(i => i.types));
    return [...meta.classes.map(c => ({ iri: c.iri, name: c.name })), ...[...types].map(iri => ({ iri }))];
}

/** Labels of the instances that are not members of the collection box `collection` of `view` (for "+ member"). */
export function memberOptions(doc: Doc, viewId: string, collection: string): string[] {
    const members = new Set(boxes(doc.views[viewId], 'collection').find(c => c.id === collection)?.members ?? []);
    return [...new Set(Object.values(doc.instances).filter(i => !members.has(i.id)).map(i => i.label))].sort();
}

/** The instances with the label or IRI `text`. */
export function instancesNamed(doc: Doc, text: string): string[] {
    return Object.values(doc.instances).filter(i => i.label === text || i.uri === text).map(i => i.id);
}

/** The statements of an instance in the read model, for the given predicates. Relations give the IRI of the target. */
export function describeInstance(doc: Doc, inst: Instance, predicates: string[]): Description {
    const d: Description = {};
    for (const p of predicates) {
        const values: TermJSON[] = p === LABEL ? [{ termType: 'Literal', value: inst.label }] : [...inst.fields[p] ?? []];
        for (const r of Object.values(doc.relations)) {
            if (r.subject === inst.id && r.predicate === p && doc.instances[r.object]) {
                values.push({ termType: 'NamedNode', value: doc.instances[r.object].uri });
            }
        }
        d[p] = values;
    }
    return d;
}
