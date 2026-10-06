// Data of the view editor gestures and of the Appearance panel (ADR 0007 step 5). The backend computes it on its store for one
// request; the frontend keeps no model. A connect gesture sends the ids of its candidate targets (what the canvas shows) and gets,
// for each one, why it is not a target ('' : it is one); the canvas then checks the drag synchronously.

import { Rect, arrowProblem, freeRelations, reconnectProblem } from './commands';
import { Doc, EdgeLayout, View, ViewBox, boxOf, boxShowing, cardOf, edgeLayout, elementOfId, isHidden, kindOf, placementOfId, relationsInView, viewsShowing } from './doc';
import { elementLabel, relationLabel } from './labels';
import { Classes, ConceptDef, predicateName } from './metamodel';
import { NodeShape, PropertyShape, ValueSet, broaderProblem, conceptParents, isValueSetMember, propertyTargetProblem } from './shapes-doc';

/** A gesture of a view editor and the ids of its candidate targets, as the canvas finds them (card: its element id). */
export type ViewGesture =
    /** Drag of an edge end: a relation moves its end; a property shape retargets its target end. */
    | { kind: 'reconnect'; relation: string; end: 'source' | 'target'; cards: string[] }
    /** Link button of an instance card: a relation to a card, an arrow to a note (`boxes`). */
    | { kind: 'link'; source: string; cards: string[]; boxes: string[] }
    /** Incoming link button of an instance card: a relation from a card to `source`, an arrow to a note. */
    | { kind: 'linkIn'; source: string; cards: string[]; boxes: string[] }
    /** Link button of a node shape: a property to a card, an arrow to a note. */
    | { kind: 'shapeLink'; source: string; cards: string[]; boxes: string[] }
    /** Incoming link button of a node shape: a property of another node shape to `source`, an arrow to a note. */
    | { kind: 'shapeLinkIn'; source: string; cards: string[]; boxes: string[] }
    /** Arrow button of a note. */
    | { kind: 'arrow'; source: string; boxes: string[] }
    /** Drag of a row out of its card. */
    | { kind: 'row'; row: string; cards: string[] }
    /** Drag of a concept onto another concept (IRIs). */
    | { kind: 'broader'; uri: string; concepts: string[] }
    /** Logic handle of a property edge: properties (edges, rows) and constraint circles. */
    | { kind: 'logic'; from: string; ids: string[] }
    /** "+ target" handle of a property edge. */
    | { kind: 'target'; property: string; cards: string[] }
    /** No targets: the facts of one element. */
    | { kind: 'element'; id: string };

/** Lists of candidate targets of a gesture. */
export type TargetList = 'cards' | 'boxes' | 'concepts' | 'ids';

export interface GestureInfo {
    /** Per list, per candidate id: why it is not a target; '': it is one. */
    problems: Partial<Record<TargetList, Record<string, string>>>;
    /** The element of the gesture (source, relation, row, property, id): its stored box in the view (a card by its element id). */
    box?: ViewBox;
    property?: PropertyShape;
    nodeShape?: NodeShape;
    valueSet?: ValueSet;
    /** The stored box of the card of the node shape of `property` in the view. */
    ownerBox?: Rect;
}

/** The main element of a gesture. */
function subjectOf(g: ViewGesture): string | undefined {
    switch (g.kind) {
        case 'reconnect': return g.relation;
        case 'link': case 'linkIn': case 'shapeLink': case 'shapeLinkIn': case 'arrow': return g.source;
        case 'row': return g.row;
        case 'logic': return g.from;
        case 'target': return g.property;
        case 'element': return g.id;
        case 'broader': return undefined;
    }
}

/**
 * The problems of the candidate targets of gesture `g` in `view` (the stored view), with the rules that the canvas used: the same
 * functions on the read model `doc` of the whole model. An undefined problem is ''.
 */
export function viewGesture(doc: Doc, meta: Classes & { concepts?: ConceptDef[] }, view: View | undefined, g: ViewGesture): GestureInfo {
    const { shapes } = doc;
    const each = (ids: string[], problem: (id: string) => string | undefined) => Object.fromEntries(ids.map(id => [id, problem(id) ?? '']));
    const arrow = (from: string) => (to: string) => view && to ? arrowProblem(view, from, to) : 'An arrow connects two elements of the view.';
    const problems: GestureInfo['problems'] = {};
    switch (g.kind) {
        case 'reconnect': {
            const property = shapes.properties[g.relation], r = doc.relations[g.relation];
            problems.cards = each(g.cards, c => {
                if (!property) return r ? reconnectProblem(meta, doc, r, g.end, c) : 'The relation is gone.';
                if (g.end === 'source') return 'A property belongs to its node shape: its start does not move. Delete it and draw it again from the other shape.';
                return propertyTargetProblem(shapes, c, [property.range]);
            });
            break;
        }
        case 'link': case 'linkIn':
            problems.cards = each(g.cards, c => {
                const self = doc.instances[g.source], other = doc.instances[c];
                if (!self || !other) return 'A relation connects two instances.';
                const free = g.kind === 'link' ? freeRelations(meta, doc, self, other) : freeRelations(meta, doc, other, self);
                return 'error' in free ? free.error : undefined;
            });
            problems.boxes = each(g.boxes, arrow(g.source));
            break;
        case 'shapeLink':
            problems.cards = each(g.cards, c => propertyTargetProblem(shapes, c));
            problems.boxes = each(g.boxes, arrow(g.source));
            break;
        case 'shapeLinkIn':
            // The other card owns the new property: a node shape. Its target is `source`.
            problems.cards = each(g.cards, c => shapes.nodeShapes[c] ? undefined : 'Only a node shape has properties: drag to a node shape.');
            problems.boxes = each(g.boxes, arrow(g.source));
            break;
        case 'arrow':
            problems.boxes = each(g.boxes, arrow(g.source));
            break;
        case 'row':
            problems.cards = each(g.cards, c => propertyTargetProblem(shapes, c) ?? (c === shapes.properties[g.row]?.owner ? 'The property is a row of this card.' : undefined));
            break;
        case 'broader': {
            const parents = conceptParents(shapes, meta.concepts);
            problems.concepts = each(g.concepts, u => broaderProblem(g.uri, u, x => isValueSetMember(shapes, x), parents));
            break;
        }
        case 'logic': {
            const owner = shapes.properties[g.from]?.owner;
            problems.ids = each(g.ids, to => {
                const p = to ? shapes.properties[to] : undefined;
                if (!to || to === g.from) return 'Drag to another property.';
                if (p ? p.owner !== owner : shapes.constraints[to]?.owner !== owner) return 'A logical constraint combines properties of one node shape.';
                return p?.constraint ? 'The property is in a logical constraint already: drag to its circle.' : undefined;
            });
            break;
        }
        case 'target': {
            const p = shapes.properties[g.property];
            problems.cards = each(g.cards, c => p ? propertyTargetProblem(shapes, c, [p.range]) : 'The property is gone.');
            break;
        }
        case 'element':
            break;
    }
    const id = subjectOf(g);
    if (id === undefined) return { problems };
    const property = shapes.properties[id];
    const ownerBox = property && cardOf(view, property.owner);
    const box = boxOf(view, id) ?? cardOf(view, id);
    return {
        problems, ...(box ? { box } : {}), ...(property ? { property } : {}), ...(shapes.nodeShapes[id] ? { nodeShape: shapes.nodeShapes[id] } : {}),
        ...(shapes.valueSets[id] ? { valueSet: shapes.valueSets[id] } : {}),
        ...(ownerBox ? { ownerBox: { x: ownerBox.x, y: ownerBox.y, width: ownerBox.width, height: ownerBox.height } } : {})
    };
}

/** The Appearance panel of a view: the stored view, the labels of the selected ids, the selected relations, the hidden edges. */
export interface AppearanceData {
    view: View;
    /** `elementLabel` of each selected id in the view ('' when none). */
    labels: Record<string, string>;
    /** Selected relations: predicate name; the view has both ends. */
    relations: Record<string, { name: string; inView: boolean; layout: EdgeLayout }>;
    /** Relations with both ends in the view and no placement. */
    hidden: { id: string; label: string }[];
}

export function appearanceData(doc: Doc, meta: Classes, view: View, ids: string[]): AppearanceData {
    const shown = relationsInView(doc, view);
    const relations: AppearanceData['relations'] = {};
    for (const id of ids) {
        const r = doc.relations[id];
        if (r) relations[id] = { name: predicateName(meta, r.predicate), inView: shown.some(x => x.id === id), layout: edgeLayout(view, id) ?? { relation: id } };
    }
    return {
        view,
        labels: Object.fromEntries(ids.map(id => [id, elementLabel(doc, meta, id, view) ?? ''])),
        relations,
        hidden: shown.filter(r => isHidden(view, r.id)).map(r => ({ id: r.id, label: relationLabel(doc, meta, r.id) }))
    };
}

/** The views that show an element (`viewsShowing`, sorted by label) and the box of each that shows it (`boxShowing`, else its placement). */
export interface Showing {
    id: string;
    /** The element is a view. */
    isView: boolean;
    views: { id: string; label: string; box: string }[];
}

export function showing(doc: Doc, id: string): Showing {
    return { id, isView: !!doc.views[id], views: viewsShowing(doc, id).map(v => ({ id: v.id, label: v.label, box: boxShowing(doc, v, id) ?? placementOfId(v, id) })) };
}

/** `Showing` of the selected element (F3 and the status bar entry), with its label. */
export interface Occurrence extends Showing {
    label: string;
}

/**
 * The occurrences of the selection `ids` of view `viewId`, when it is one instance or one relation (collections, arrows and shape
 * elements may be selected with it; views, groups, notes and references may not), or one node shape or value set alone.
 */
export function occurrence(doc: Doc, meta: Classes, ids: string[], viewId?: string): Occurrence | undefined {
    const view = viewId ? doc.views[viewId] : undefined;
    const elements = [...new Set(ids.map(id => elementOfId(view, id)))];
    const kinds = elements.map(id => kindOf(doc, view, id));
    const count = (...ks: string[]) => kinds.filter(k => k !== undefined && ks.includes(k)).length;
    // One node shape or value set alone: its views too (Show in a View applies to it).
    const shape = elements.length === 1 && (kinds[0] === 'shape' || kinds[0] === 'valueSet') ? elements[0] : undefined;
    if (!shape && (count('instance', 'relation') !== 1 || count('view', 'group', 'note', 'reference') !== 0)) return undefined;
    const id = shape ?? elements[kinds.findIndex(k => k === 'instance' || k === 'relation')];
    const label = elementLabel(doc, meta, id);
    return label === undefined ? undefined : { ...showing(doc, id), label };
}
