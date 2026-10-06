// Labels of elements for lists, titles and messages: the same text in every view.

import { Doc, View, boxOf, elementOfId, kindOf } from './doc';
import { Classes, predicateName, primaryClass } from './metamodel';
import { formatPath } from './shapes-doc';

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
