// Data of the Model properties panel (ADR 0007 step 2). The backend gives it by SPARQL (packages/rdf/src/properties.ts) for the
// selected element; the frontend asks when the selection or the model changes.

import { Doc, Instance, boxes, isHidden, relationsInView } from './doc';
import type { Description } from './form';
import { NS, TermJSON, termKey } from './terms';
import type { Violation } from './validation';

/** A result of the SHACL report graph, as the panel shows it. */
export interface ResultRow {
    /** Focus node IRI. */
    focus: string;
    /** Label of the focus node if it is an instance, else its IRI. */
    focusLabel: string;
    pathName?: string;
    severity: Violation['severity'];
    message: string;
}

/** An instance (the fields of `Instance`, from its graph) and what the panel shows with it. */
export interface InstanceProperties extends Instance {
    kind: 'instance';
    /** Predicate IRI -> IRIs of the instances that are objects (relations). */
    targets: Record<string, string[]>;
    /** Node shapes with an sh:targetClass that is one of the types; by label. */
    shapes: { id: string; uri: string; label: string }[];
    /** The results of the report graph with the instance as focus node. */
    results: ResultRow[];
    /** The other instances as the SHACL form sees them (link candidates): sorted N-Triples lines. */
    candidates: string;
    /** The protected files (absolute paths) with statements of the instance. Absent: none. */
    importedFiles?: string[];
    /** The statements of the instance in imported files, as `lockedKey(predicate, object)`. A change of them is refused. */
    locked?: string[];
}

/** The key of a statement of an instance in `InstanceProperties.locked`. */
export const lockedKey = (predicate: string, object: TermJSON): string => `${predicate} ${termKey(object)}`;

/** An end of a relation. */
export interface RelationEnd { id: string; uri: string; label: string; types: string[] }

export interface RelationProperties {
    kind: 'relation';
    id: string;
    predicate: string;
    subject: RelationEnd;
    object: RelationEnd;
}

/** A property shape: the results of the report graph with it as source shape. The rest comes from the shapes index (not yet a query). */
export interface PropertyShapeProperties {
    kind: 'propertyShape';
    id: string;
    results: ResultRow[];
}

/** A view: its identity and what it holds. */
export interface ViewProperties {
    kind: 'view';
    description: string;
    id: string;
    uri: string;
    label: string;
    /** Cards of instances and value sets, cards of node shapes, notes, view references. */
    cards: number;
    shapes: number;
    notes: number;
    references: number;
    /** Relations with both ends in the view, and the hidden ones of them. */
    relations: number;
    hidden: number;
}

/** The Properties data of view `viewId` from the read model of the view (`ModelStore.viewDoc`). Undefined: no such view. */
export function viewProperties(part: Doc, viewId: string): ViewProperties | undefined {
    const view = part.views[viewId];
    if (!view) return undefined;
    const rels = relationsInView(part, view);
    const cards = boxes(view, 'card');
    const shapes = cards.filter(n => part.shapes.nodeShapes[n.element]).length;
    return {
        kind: 'view', description: view.description ?? '', id: view.id, uri: view.uri, label: view.label, cards: cards.length - shapes, shapes, notes: boxes(view, 'note').length,
        references: boxes(view, 'reference').length, relations: rels.length, hidden: rels.filter(r => isHidden(view, r.id)).length
    };
}

/** No element: counts of the store. */
export interface WorkspaceProperties {
    kind: 'workspace';
    instances: number;
    relations: number;
    views: number;
    /** Results with severity sh:Violation. */
    violations: number;
}

export type ElementProperties = InstanceProperties | RelationProperties | PropertyShapeProperties | ViewProperties | WorkspaceProperties;

/** The statements of an instance for the given predicates, as `describeInstance` gives them from the read model. */
export function describeProperties(p: InstanceProperties, predicates: string[]): Description {
    const d: Description = {};
    for (const pred of predicates) {
        d[pred] = pred === NS.rdfs + 'label' ? [{ termType: 'Literal', value: p.label }]
            : [...p.fields[pred] ?? [], ...(p.targets[pred] ?? []).map(value => ({ termType: 'NamedNode' as const, value }))];
    }
    return d;
}
