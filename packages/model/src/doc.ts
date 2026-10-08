// Read model of the document: instances, relations and views as plain JSON.
// @catenary/rdf derives it from the quads; edits never change it (they are EditCommands).

import { ShapesModel, emptyShapes } from './shapes-doc';
import type { TermJSON } from './terms';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

export const DEFAULT_SIZE = { width: 640, height: 320 };
export const DEFAULT_NOTE_SIZE = { width: 320, height: 180 };
export const DEFAULT_VIEW_REFERENCE_SIZE = { width: 280, height: 96 };
export const DEFAULT_COLLECTION_SIZE = { width: 320, height: 240 };
export const MIN_GROUP = { width: 160, height: 100 };
/** Size of a group without width or height in the file. Cards without a size get DEFAULT_SIZE. */
export const GROUP_SIZE = { width: 400, height: 300 };

export type Box = { x: number; y: number; width: number; height: number };

/** Box r lies fully inside box g. */
export const inside = (r: Box, g: Box) => r.x >= g.x && r.y >= g.y && r.x + r.width <= g.x + g.width && r.y + r.height <= g.y + g.height;

export interface Instance {
    id: string;
    label: string;
    types: string[];                         // rdf:type IRIs, sorted
    uri: string;                             // IRI
    fields: Record<string, TermJSON[]>;      // predicate IRI -> values (IRIs of instances are relations, not fields)
    file?: string;                           // the file with most of its statements (ADR 0004)
}

export interface Relation {
    id: string;
    subject: string;     // instance id
    predicate: string;   // IRI
    object: string;      // instance id
}

export type CardDisplay = 'simple' | 'detailed';

/** The fields of every box of a view. */
interface BoxBase extends Box {
    id: string;
    color?: string;
}

/**
 * The card of an element in a view. `id`: the id of its placement (spec/ui-manifest.hs §2: a placement is not its element).
 * `element`: instance id; in a shapes view also node shape, value set, or property shape taken out of its card (its pill).
 */
export interface ViewCard extends BoxBase {
    kind: 'card';
    element: string;
    /** Card content: 'simple' shows the class and the name only. Absent: detailed. */
    display?: CardDisplay;
}

/** A named, colored rectangle in a view. Layout only: it has no meaning in the model. */
export interface ViewGroup extends BoxBase {
    kind: 'group';
    label: string;
}

/** Free-positioned text that belongs to one view, not to the model. */
export interface ViewNote extends BoxBase {
    kind: 'note';
    text: string;
}

/** A positioned link from one view to another. Multiple links to the same target are allowed. */
/** A link box: to a view (`target`), or to a file (`file`, ADR 0004). */
export interface ViewReference extends BoxBase {
    kind: 'reference';
    target?: string;      // target view id
    /** File reference: the path relative to the view file (view:file); `path`: absolute; `broken`: the file is not on disk. */
    file?: string;
    path?: string;
    broken?: boolean;
}

/**
 * Cards of one view shown as one box with a list, as a Reactodia entity group. The members keep their cards (they are in the view,
 * their relations show), but the view editor draws the collection instead of their cards, and bundles their edges.
 */
export interface ViewCollection extends BoxBase {
    kind: 'collection';
    members: string[];    // instance ids
}

export type ViewBox = ViewCard | ViewGroup | ViewNote | ViewReference | ViewCollection;
export type BoxKind = ViewBox['kind'];

/** The boxes of one kind in a view, in view order. */
export function boxes<K extends BoxKind>(view: View | undefined, kind: K): Extract<ViewBox, { kind: K }>[] {
    return view?.boxes.filter((b): b is Extract<ViewBox, { kind: K }> => b.kind === kind) ?? [];
}

/** The box with this id in a view: the id of its placement. */
export function boxOf(view: View | undefined, id: string): ViewBox | undefined {
    return view?.boxes.find(b => b.id === id);
}

/** The card of an element (by element id) in a view. */
export function cardOf(view: View | undefined, elementId: string): ViewCard | undefined {
    return view?.boxes.find((b): b is ViewCard => b.kind === 'card' && b.element === elementId);
}

/**
 * The element that a placement of `view` places: a card its element, a placed edge its relation. Other ids stay: an element id,
 * and the placement of a mark, a view reference or an arrow (the read model identifies these by their placement).
 */
export function elementOfId(view: View | undefined, id: string): string {
    const b = boxOf(view, id);
    if (b?.kind === 'card') return b.element;
    return view?.edges.find(e => e.id === id)?.relation ?? id;
}

/** The placement ids that show an element id in `view`: its card or its placed edge. Other ids stay. */
export function placementOfId(view: View | undefined, id: string): string {
    return cardOf(view, id)?.id ?? view?.edges.find(e => e.relation === id && e.id)?.id ?? id;
}

/**
 * An arrow from one box of a view to another (card, group, note, view reference, collection), with a note at one end at least.
 * Informative only: it belongs to the view graph, not to the model. `from`, `to`: box ids (a card: the id of its placement).
 */
export interface ViewArrow {
    id: string;
    from: string;
    to: string;
    color?: string;
}

/** Layout or visibility of one relation in one view. Present only when it has data. */
export interface EdgeLayout {
    /** Id of the placement of the relation; absent when the view does not place it (hidden). */
    id?: string;
    relation: string;    // relation id
    fromSide?: Side;
    toSide?: Side;
    color?: string;
    hidden?: boolean;
}

export interface View {
    id: string;
    label: string;
    uri: string;         // graph IRI
    /** Free-text Markdown explanation, stored in the view graph. */
    description?: string;
    /** Cards, groups, notes, view references and collections. */
    boxes: ViewBox[];
    edges: EdgeLayout[];
    arrows: ViewArrow[];
}

export interface Doc {
    conformsTo?: string;
    instances: Record<string, Instance>;
    relations: Record<string, Relation>;
    views: Record<string, View>;
    /** Node shapes, property shapes and logical constraints of the shapes files (empty in the part of a view without shape elements). */
    shapes: ShapesModel;
}

export function emptyDoc(): Doc {
    return { instances: {}, relations: {}, views: {}, shapes: emptyShapes() };
}

/** Order by label. */
export const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

/** The view shows the instance: its card, or a member row of an entity group (ADR 0014, C1: a member has no placement). */
export const inView = (view: View | undefined, instanceId: string) => !!cardOf(view, instanceId) || boxes(view, 'collection').some(c => c.members.includes(instanceId));

/** Both ends of the relation are in the view: the view shows the edge, or hides it. */
export const hasEnds = (view: View | undefined, r: Relation | undefined) => !!r && inView(view, r.subject) && inView(view, r.object);

/** A view shows a property shape or a logical constraint when it shows the card of its node shape; a value set when it has its node. */
export function shapeElementInView(doc: Doc, view: View | undefined, id: string): boolean {
    if (!view) return false;
    if (doc.shapes.valueSets[id]) return inView(view, id);
    const owner = doc.shapes.properties[id]?.owner ?? doc.shapes.constraints[id]?.owner ?? (doc.shapes.nodeShapes[id] ? id : undefined);
    return !!owner && inView(view, owner);
}

/**
 * The box of `view` that shows an instance: its card, else the card of a concept scheme or collection that lists it as a member
 * row (a concept shown in its value set card). Undefined: the view does not show it.
 */
export function boxShowing(doc: Doc, view: View | undefined, instanceId: string): string | undefined {
    if (!view) return undefined;
    const card = cardOf(view, instanceId);
    if (card) return card.id;
    const uri = doc.instances[instanceId]?.uri;
    if (!uri) return undefined;
    const set = Object.values(doc.shapes.valueSets).find(s => inView(view, s.id) && s.members.some(m => m.uri === uri));
    return set && cardOf(view, set.id)?.id;
}

/**
 * Instances related to `id` that `view` does not show (`boxShowing`), with the relations to each, by label. 'out': objects of the
 * relations of `id`; 'in': subjects of the relations to `id`. The halo expand buttons of a card.
 */
export function hiddenNeighbors(doc: Doc, view: View | undefined, id: string, dir: 'in' | 'out'): { instance: Instance; relations: Relation[] }[] {
    const found = new Map<string, Relation[]>();
    for (const r of Object.values(doc.relations)) {
        const [self, other] = dir === 'out' ? [r.subject, r.object] : [r.object, r.subject];
        if (self !== id || other === id || !doc.instances[other] || boxShowing(doc, view, other) !== undefined) continue;
        found.set(other, [...(found.get(other) ?? []), r]);
    }
    return [...found].map(([other, relations]) => ({ instance: doc.instances[other], relations })).sort((a, b) => byLabel(a.instance, b.instance));
}

export function viewsUsing(doc: Doc, instanceId: string): View[] {
    return Object.values(doc.views).filter(v => boxShowing(doc, v, instanceId) !== undefined).sort(byLabel);
}

/** Incoming view-reference elements and the views that contain them. */
export function viewReferencesTo(doc: Doc, targetViewId: string): { source: View; reference: ViewReference }[] {
    return Object.values(doc.views).sort(byLabel).flatMap(source => boxes(source, 'reference')
        .filter(reference => reference.target === targetViewId)
        .map(reference => ({ source, reference })));
}

/** Relations shown (or hidden) in a view: all relations whose two ends are in the view. */
export function relationsInView(doc: Doc, view: View): Relation[] {
    return Object.values(doc.relations).filter(r => hasEnds(view, r));
}

/** The collection that holds an instance in a view, if any. */
export function collectionOf(view: View, instanceId: string): ViewCollection | undefined {
    return boxes(view, 'collection').find(c => c.members.includes(instanceId));
}

export function edgeLayout(view: View, relationId: string): EdgeLayout | undefined {
    return view.edges.find(e => e.relation === relationId);
}

export function isHidden(view: View, relationId: string): boolean {
    return edgeLayout(view, relationId)?.hidden === true;
}

export function findRelation(doc: Doc, subject: string, predicate: string, object: string): Relation | undefined {
    return Object.values(doc.relations).find(r => r.subject === subject && r.predicate === predicate && r.object === object);
}

/**
 * Views that show an element, sorted by label. An instance: the view has its card. A relation: the view has both ends and
 * the edge is not hidden there (with `includeHidden`, also when it is hidden).
 */
export function viewsShowing(doc: Doc, id: string, includeHidden = false): View[] {
    if (doc.shapes.nodeShapes[id] || doc.shapes.properties[id] || doc.shapes.constraints[id] || doc.shapes.valueSets[id]) {
        return Object.values(doc.views).filter(v => shapeElementInView(doc, v, id)).sort(byLabel);
    }
    const r = doc.relations[id];
    if (!r) return viewsUsing(doc, id);
    return Object.values(doc.views).filter(v => hasEnds(v, r) && (includeHidden || !isHidden(v, id))).sort(byLabel);
}

export type ElementKind = 'instance' | 'relation' | 'view' | 'group' | 'note' | 'reference' | 'collection' | 'arrow' | 'shape' | 'property' | 'constraint' | 'valueSet';

/** Kind of an element id. Groups, notes, view references, collections and arrows belong to a view: they are found only in `view`. */
export function kindOf(doc: Doc, view: View | undefined, id: string): ElementKind | undefined {
    // A shape wins over an instance with the same IRI (as its card): a node shape, or a concept scheme or collection of the data file.
    if (doc.shapes.nodeShapes[id]) return 'shape';
    if (doc.shapes.valueSets[id]) return 'valueSet';
    if (doc.instances[id]) return 'instance';
    if (doc.relations[id]) return 'relation';
    if (doc.views[id]) return 'view';
    if (doc.shapes.properties[id]) return 'property';
    if (doc.shapes.constraints[id]) return 'constraint';
    const box = boxOf(view, id);
    if (box && box.kind !== 'card') return box.kind;
    // The placement of a card or an edge: the kind of its element.
    const element = elementOfId(view, id);
    if (element !== id) return kindOf(doc, view, element);
    if (view?.arrows.some(a => a.id === id)) return 'arrow';
    return undefined;
}

/**
 * The group that holds a box (card, note, view reference or group) with the id `id`: the smallest group that contains it.
 * Equal boxes: the group with the lower id holds the other (no cycles). Apply Layout and the Outline use this rule.
 */
export function groupOf(view: View, box: Box, id: string): ViewGroup | undefined {
    return groupAmong(boxes(view, 'group'), box, id);
}

/** groupOf on a list of groups (in view order): the Outline query of the backend gives the groups without a View. */
export function groupAmong<G extends Box & { id: string }>(groups: G[], box: Box, id: string): G | undefined {
    const area = (b: Box) => b.width * b.height;
    return groups
        .filter(g => g.id !== id && inside(box, g) && (area(g) > area(box) || g.id < id))
        .sort((a, b) => area(a) - area(b))[0];
}

/** A statement of the model or shapes graphs between a selected element and another term (SPARQL, see `links` in @catenary/rdf). */
export interface LinkRow {
    /** Id of the selected element. */
    element: string;
    /** 'out': the element is the subject; 'in': the element is the object. An RDF list between them counts as one step. */
    dir: 'out' | 'in';
    predicate: string;
    /** Element id of the other end (instance, view, node shape, value set, property shape, logical constraint); undefined: not an element. */
    id?: string;
    /** IRI of the other end; undefined for a blank node. */
    iri?: string;
    /** rdfs:label, skos:prefLabel or sh:name of the other end, if any. */
    label?: string;
}

/** A view that shows a selected element: its card, the card of its node shape, a reference to it, or the element itself (view-owned). */
export interface ViewLink {
    element: string;
    view: string;
    /** A relation whose edge the view hides. */
    hidden?: boolean;
}

export interface Links {
    views: ViewLink[];
    rows: LinkRow[];
}

/** A selected element of the Links panel (a placement id resolved to its element). */
export interface LinkElement {
    id: string;
    kind: ElementKind;
    /** Label (labels.ts), else the id. */
    label: string;
    /** The class of an instance, else the name of the kind. */
    kindName: string;
    /** A relation: its ends (element ids) and their labels. */
    ends?: { subject: string; object: string; subjectLabel: string; objectLabel: string };
}

/** The Links panel data of a selection (ADR 0007): the links of its elements, with the names and states the panel shows. */
export interface SelectionLinks {
    elements: LinkElement[];
    /** Known instances targeted by selected node shapes, independent of view placement. */
    instances: { id: string; label: string; shapes: string[] }[];
    /** Views of the read model only. */
    views: (ViewLink & { label: string })[];
    rows: (LinkRow & {
        /** Row text: the label of the other end, else its element label, else its short IRI, else 'blank node'. */
        name: string;
        predicateName: string;
        /** The relation (a statement between two instances) of the row. */
        relation?: string;
        /** 'out' relation with a predicate that the shapes of the class of the element do not declare. */
        undeclared?: boolean;
    })[];
}
