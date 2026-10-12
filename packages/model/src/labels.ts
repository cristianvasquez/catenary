// Labels of elements for lists, titles and messages: the same text in every view.

import { Doc, View, boxOf, elementOfId, kindOf } from './doc';
import { Classes, predicateName, primaryClass } from './metamodel';
import { formatPath } from './shapes-doc';
import { NS } from './terms';

/** The label predicates in the order of the label rule (spec/manifest.hs labelPredicates). */
export const LABEL_PREDICATES = [NS.rdfs + 'label', NS.skos + 'prefLabel', NS.sh + 'name'] as const;

/** A label literal: its text and its language tag (none: undefined or ''). */
export type LabelLiteral = { value: string; language?: string };

/** Case-insensitive label order, then lower case first. */
export const compareLabels = (a: string, b: string) => {
    const x = a.toLowerCase().replace(/[—→]/g, '\t'), y = b.toLowerCase().replace(/[—→]/g, '\t');
    return x < y ? -1 : x > y ? 1 : a < b ? 1 : a > b ? -1 : 0;
};

/**
 * The one label rule (spec/manifest.hs §6.2 pickLabel). `literals`: one list per label predicate, in the order of LABEL_PREDICATES; the candidates are the literals of the first list that has any. Of them: a literal in `language` (equal tag, or a subtag:
 * "en" takes "en-GB"; case-insensitive), else a literal without a language, else the smallest by compareLabels. Several in one step:
 * the smallest. Undefined: no literal (the caller uses the name from the IRI).
 */
export function pickLabel(literals: LabelLiteral[][], language?: string): string | undefined {
    const candidates = literals.find(l => l.length);
    if (!candidates) return undefined;
    const sorted = [...candidates].sort((a, b) => compareLabels(a.value, b.value));
    const want = language?.trim().toLowerCase();
    const tag = (l: LabelLiteral) => (l.language ?? '').toLowerCase();
    const found = (want ? sorted.find(l => tag(l) === want || tag(l).startsWith(want + '-')) : undefined) ?? sorted.find(l => !tag(l)) ?? sorted[0];
    return found.value;
}

/** "subject — predicate → object". */
export function relationLabel(doc: Doc, meta: Classes, id: string): string {
    const r = doc.relations[id];
    if (!r) return id;
    return `${doc.instances[r.subject]?.label} — ${predicateName(meta, r.predicate)} → ${doc.instances[r.object]?.label}`;
}

/** Label of an instance, relation or view; of a group, note (first line), view reference (target), collection or arrow (its ends) of `view`. */
export function elementLabel(doc: Doc, meta: Classes, id: string, view?: View): string | undefined {
    if (doc.instances[id]) return doc.instances[id].label;
    if (doc.relations[id]) return relationLabel(doc, meta, id);
    if (doc.views[id]) return doc.views[id].label;
    const { nodeShapes, properties, constraints, valueSets } = doc.shapes;
    if (nodeShapes[id]) return nodeShapes[id].label;
    if (valueSets[id]) return valueSets[id].label;
    if (properties[id]) return `${nodeShapes[properties[id].owner]?.label} — ${formatPath(properties[id].path)}`;
    if (constraints[id]) return `${nodeShapes[constraints[id].owner]?.label} — ${constraints[id].operator} of ${constraints[id].members.length}`;
    const box = boxOf(view, id);
    if (box?.kind === 'group') return box.label;
    if (box?.kind === 'note') return box.text.split('\n')[0];
    if (box?.kind === 'reference') return box.target ? doc.views[box.target]?.label : box.file?.replace(/^.*\//, '');
    if (box?.kind === 'collection') return `Collection of ${box.members.length}`;
    const arrow = view?.arrows.find(a => a.id === id);
    return arrow ? `${elementLabel(doc, meta, arrow.from, view) || '…'} → ${elementLabel(doc, meta, arrow.to, view) || '…'}` : undefined;
}

/** Name of the kind of an element, for lists and titles: the class of an instance, "Node shape", "Note", … */
export function kindName(doc: Doc, meta: Classes, id: string, view?: View): string | undefined {
    const kind = kindOf(doc, view, id);
    // A placement of a card or an edge: the kind of its element (kindOf), and the records of its element.
    const element = elementOfId(view, id);
    if (kind === 'instance') return primaryClass(meta, doc.instances[element].types)?.name ?? 'Instance';
    if (kind === 'valueSet') return doc.shapes.valueSets[element].kind === 'scheme' ? 'Concept scheme' : 'Collection';
    if (kind === 'constraint') return `${doc.shapes.constraints[element].operator} constraint`;
    return kind && KIND_NAMES[kind];
}

const KIND_NAMES = {
    relation: 'Relation', view: 'View', group: 'Group', note: 'Note', reference: 'View reference', collection: 'Collection', arrow: 'Arrow',
    shape: 'Node shape', property: 'Property shape'
} as const;
