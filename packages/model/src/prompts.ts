// The content of the dialogs and pickers of the user actions (modeler/src/browser/actions.ts): pure functions of the read model. The
// backend runs them (RPC queries, queries.ts); the frontend shows the answer and sends the command (ADR 0007: no model in the frontend).

import { freeRelations, nextLabel, unnamedLabel } from './commands';
import { Doc, ElementKind, Instance, Relation, View, boxes, elementOfId, hiddenNeighbors, kindOf, viewReferencesTo, viewsShowing, viewsUsing } from './doc';
import { elementLabel, kindName, relationLabel } from './labels';
import { Classes, RelationDef, instanceNoun, predicateName, primaryClass } from './metamodel';
import { PropertyShape, formatPath } from './shapes-doc';
import { hiddenShapeSources } from './shapes-schema';
import { localName } from './terms';

/** Name of the class of an instance: its primary class, else the local names of its types. */
export function classNameOf(meta: Classes, inst: Instance): string {
    return primaryClass(meta, inst.types)?.name ?? (inst.types.map(localName).join(', ') || 'no type');
}

/** The confirmation of Delete from Model: one line for each element and where it is used, then notes. Empty `lines`: nothing to delete. */
export interface DeletePlan {
    lines: string[];
    notes: string[];
}

export function deletePlan(doc: Doc, meta: Classes, ids: string[]): DeletePlan {
    const { nodeShapes, properties, constraints, valueSets } = doc.shapes;
    const shown = (views: { label: string }[]) => views.length ? ` — in ${views.map(v => v.label).join(', ')}` : '';
    const lines = ids.flatMap(id => {
        if (nodeShapes[id]) return [`• node shape ${nodeShapes[id].label} with its ${nodeShapes[id].properties.length} properties${shown(viewsShowing(doc, id))}`];
        if (valueSets[id]) return [`• ${valueSets[id].kind === 'scheme' ? `concept scheme ${valueSets[id].label} with its ${valueSets[id].members.length} concepts` : `collection ${valueSets[id].label}`}`];
        if (properties[id]) return [`• property ${formatPath(properties[id].path)} of ${nodeShapes[properties[id].owner]?.label}`];
        if (constraints[id]) return [`• ${constraints[id].operator} constraint (its members stay as properties)`];
        if (doc.instances[id]) return [`• ${doc.instances[id].label}${shown(viewsUsing(doc, id))}`];
        if (doc.relations[id]) return [`• ${relationLabel(doc, meta, id)} — ${viewsShowing(doc, id).length ? `shown in ${viewsShowing(doc, id).map(v => v.label).join(', ')}` : 'not shown in any view'}`];
        if (doc.views[id]) {
            const refs = viewReferencesTo(doc, id).filter(r => !ids.includes(r.source.id));
            return [`• view ${doc.views[id].label}${refs.length ? ` and ${refs.length} reference${refs.length === 1 ? '' : 's'} to it (in ${[...new Set(refs.map(r => r.source.label))].join(', ')})` : ''}`];
        }
        return [];
    });
    if (!lines.length) return { lines, notes: [] };
    const instances = ids.filter(id => doc.instances[id] && !nodeShapes[id] && !valueSets[id]);
    const implied = Object.values(doc.relations).filter(r => !ids.includes(r.id) && (instances.includes(r.subject) || instances.includes(r.object))).length;
    const notes = [
        implied ? `Also ${implied} relation(s) to or from the deleted instances.` : '',
        ids.some(id => nodeShapes[id] || properties[id] || constraints[id]) ? 'Shapes elements change the shapes file(s); the data does not change.' : '',
        // Concept schemes and collections are data (SKOS), not shapes (F-DEL-2).
        ids.some(id => valueSets[id]) ? 'Concept schemes and collections are data: the data file(s) change.' : ''
    ].filter(Boolean);
    return { lines, notes };
}

/** Relation types from instance `source` to instance `target` that the shapes permit and that do not exist yet; else why there are none. */
export type RelationChoices = { title: string; types: RelationDef[] } | { error: string };

export function relationChoices(doc: Doc, meta: Classes, source: string, target: string): RelationChoices | undefined {
    const s = doc.instances[source], t = doc.instances[target];
    if (!s || !t) return undefined;
    const free = freeRelations(meta, doc, s, t);
    if ('error' in free) return free;
    return { title: `${classNameOf(meta, s)} → ${classNameOf(meta, t)}: pick a relation type`, types: free.types };
}

/** An item of a picker: its label, description, and the element ids that it acts on. */
export interface ChoiceItem {
    label: string;
    description?: string;
    ids: string[];
}

/** The items of a picker and its title. */
export interface Choices {
    title: string;
    items: ChoiceItem[];
}

/**
 * Halo expand button of an instance card: the instances related to `from` (dir 'in': subjects of its relations; 'out': objects) that the
 * view does not show. Each item: the relations to show. Undefined: no such instance, or the view shows all.
 */
export function neighborChoices(doc: Doc, meta: Classes, viewId: string, from: string, dir: 'out' | 'in'): Choices | undefined {
    const view = doc.views[viewId];
    const self = doc.instances[elementOfId(view, from)];
    if (!self) return undefined;
    const hidden = hiddenNeighbors(doc, view, self.id, dir);
    if (!hidden.length) return undefined;
    const names = (rs: Relation[]) => [...new Set(rs.map(r => predicateName(meta, r.predicate)))].sort().map(n => dir === 'out' ? `${n} →` : `← ${n}`).join(', ');
    return {
        title: `${self.label}: ${dir === 'out' ? 'outgoing' : 'incoming'} (${hidden.length} not in the view)`,
        items: hidden.map(n => ({ label: n.instance.label, description: names(n.relations), ids: n.relations.map(r => r.id) }))
    };
}

/** Halo incoming button of a node shape card: the node shapes with a property to `from` that the view does not show. Item ids: the node shape. */
export function shapeSourceChoices(doc: Doc, viewId: string, from: string): Choices | undefined {
    const view = doc.views[viewId];
    const id = elementOfId(view, from);
    const self = doc.shapes.nodeShapes[id];
    if (!self) return undefined;
    const hidden = hiddenShapeSources(doc.shapes, view, id);
    if (!hidden.length) return undefined;
    const names = (ps: PropertyShape[]) => [...new Set(ps.map(p => p.name ?? formatPath(p.path)))].sort().map(n => `← ${n}`).join(', ');
    return {
        title: `${self.label}: incoming (${hidden.length} not in the view)`,
        items: hidden.map(n => ({ label: n.shape.label, description: names(n.properties) || 'sh:node', ids: [n.shape.id] }))
    };
}

/** A relation type of the link picker (packages/rdf/src/link-choices.ts): its header, the instances it can link to, and the new end that it can create. */
export interface LinkSection {
    header: string;
    predicate: string;
    /** The relation type, as the description of its items. */
    name: string;
    candidates: { id: string; label: string; description: string }[];
    /** The number of candidates not listed (the list has a limit). Undefined: all are listed. */
    more?: number;
    /** A new other end: an instance of `classIri` (a concept of `scheme`, when given). Undefined: none can be created. */
    create?: { classIri: string; scheme?: string; label: string; item: string; creator: string };
}

/** "unnamed <class> N": the label of a new instance of `classIri`. */
export function newInstanceLabel(doc: Doc, meta: Classes, classIri?: string): string {
    const cls = meta.classes.find(c => c.iri === classIri);
    return unnamedLabel(cls ? instanceNoun(cls) : 'instance', Object.values(doc.instances));
}

/** What a new element is: the label of `newLabel` counts the elements of this kind. */
export type NewLabelKind = 'instance' | 'concept' | 'view' | 'shape' | 'scheme' | 'collection' | 'group' | 'property';

/**
 * The label of a new element: "unnamed <kind> N", the first one free among the elements of its kind. `classIri`: the class of a new
 * instance. `view`: the view of a new group. `base`: a label to use when it is free, else the next free label (a view only).
 */
export function newLabel(doc: Doc, meta: Classes, kind: NewLabelKind, opts: { classIri?: string; view?: string; base?: string } = {}): string {
    const { shapes } = doc;
    switch (kind) {
        case 'instance': return newInstanceLabel(doc, meta, opts.classIri);
        case 'concept': return unnamedLabel('concept', Object.values(doc.instances));
        case 'view': {
            if (!opts.base) return unnamedLabel('view', Object.values(doc.views));
            const used = new Set(Object.values(doc.views).map(v => v.label));
            return used.has(opts.base) ? nextLabel(opts.base, used) : opts.base;
        }
        case 'shape': return unnamedLabel('shape', Object.values(shapes.nodeShapes));
        case 'scheme': return unnamedLabel('scheme', Object.values(shapes.valueSets));
        case 'collection': return unnamedLabel('collection', Object.values(shapes.valueSets));
        case 'group': return unnamedLabel('group', boxes(opts.view ? doc.views[opts.view] : undefined, 'group'));
        case 'property': return unnamedLabel('property', Object.values(shapes.properties).map(p => ({ label: formatPath(p.path) })));
    }
}

/** Predicates in use: paths of the shapes, fields and relations of the metamodel, predicates of the data. Where each one is used. */
export function knownPredicates(doc: Doc, meta: Classes): { iri: string; where: string }[] {
    const known = new Map<string, { iri: string; where: string }>();
    const add = (iri: string, where: string) => { if (!known.has(iri)) known.set(iri, { iri, where }); };
    for (const p of Object.values(doc.shapes.properties)) if (p.path.kind === 'iri') add(p.path.iri, doc.shapes.nodeShapes[p.owner]?.label ?? 'shapes');
    for (const c of meta.classes) for (const f of [...c.fields, ...c.relations]) add(f.path, c.name);
    for (const i of Object.values(doc.instances)) for (const p of Object.keys(i.fields)) add(p, 'data');
    for (const r of Object.values(doc.relations)) add(r.predicate, 'data');
    return [...known.values()];
}

/** A row of a list of elements: its label, its kind and the name of its kind. */
export interface ElementRow {
    id: string;
    /** Undefined: the element has no label (an unknown id). */
    label?: string;
    /** Undefined: an unknown id. */
    kind?: ElementKind;
    /** The class of an instance, "Node shape", "Note", … */
    kindName: string;
}

/**
 * Label and kind of elements of any kind; `viewId`: the view of marks (groups, notes, …) and placements. A placement of a card or an
 * edge gives the label and kind of its element. Sorted by label.
 */
export function elementRows(doc: Doc, meta: Classes, ids: string[], viewId?: string): ElementRow[] {
    const view: View | undefined = viewId ? doc.views[viewId] : undefined;
    return ids.map(id => {
        const element = elementOfId(view, id);
        return { id, label: elementLabel(doc, meta, element, view), kind: kindOf(doc, view, id), kindName: kindName(doc, meta, element, view) ?? '' };
    })
        .sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id));
}
