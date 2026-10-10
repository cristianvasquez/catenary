// Edit operations on the dataset. Each operation adds and removes quads through ModelGraph (so that the
// store can undo them), or returns an error. On an error the caller rolls the transaction back.
// Arguments are element ids (see graph.ts); an operation resolves them to terms.

import {
    Box, Classes, DEFAULT_COLLECTION_SIZE, DEFAULT_NOTE_SIZE, DEFAULT_SIZE, DEFAULT_VIEW_REFERENCE_SIZE, EdgeLayout, GROUP_SIZE, LEAF_SUFFIX, MIN_GROUP, NS,
    RDFS_LABEL, RDF_TYPE, TermJSON, ViewElementPatch, centered, gridPositions, inside, labelProblem, permittedRelations, alternativesOf, targetSize,
    pillSize, pills, rangeText
} from '@catenary/model';
import type { Literal, NamedNode, Quad, Quad_Object, Quad_Predicate, Quad_Subject, Term } from '@rdfjs/types';
import { ModelGraph, P, V, mint, placementIri, viewPartBase } from './graph';
import { skolemIri } from './skolem';
import { elementId, elementTerm, relationId, relationTriple } from './ids';
import { shapesCardTerm, shapesIndex } from './shape-ops';
import { jsonToTerm, mapTerm, rdf } from './terms';

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: string): Result<never> => ({ ok: false, error });
/** An id that names no element of this kind: the caller gave a wrong id, or the element was deleted. */
export const gone = (what: string, id: string): Result<never> => fail(`No ${what} with the id ${id}: the id is wrong or the ${what} was deleted.`);

const RDF_FIRST = rdf.namedNode(NS.rdf + 'first');
const integer = (n: number) => rdf.literal(String(Math.round(n) || 0), rdf.namedNode(NS.xsd + 'integer'));

// ------------------------------------------------------------------ resolve ids

export function instanceTerm(g: ModelGraph, id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return g.isInstance(t) ? t : undefined;
}

/** A node shape, value set or property shape with an IRI: drawn as a shape element. */
export function shapeCardTerm(g: ModelGraph, id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return t?.termType === 'NamedNode' && g.match(t).some(q => g.isShapesGraph(q.graph)) ? shapesCardTerm(g, id) : undefined;
}

/** The element of a card in a view: a shape element, else an instance, else a class pill, else a list figure (ADR 0014). A shape wins when the same IRI is both. */
export function cardTerm(g: ModelGraph, id: string): NamedNode | undefined {
    return shapeCardTerm(g, id) ?? instanceTerm(g, id) ?? pillTerm(g, id) ?? listTerm(id);
}

/** The term of a list figure ("in", "one of", hub): `urn:trellis:list:<hash>` (ADR 0014 rule 12). It has no statements. */
export const LIST_PREFIX = 'urn:trellis:list:';
function listTerm(id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return t?.termType === 'NamedNode' && t.value.startsWith(LIST_PREFIX) ? t : undefined;
}

/** The IRI of a pill (`pills`): a datatype, node kind or class without a node shape that is the range of a property shape. */
export function pillTerm(g: ModelGraph, id: string): NamedNode | undefined {
    const pill = pills(shapesIndex(g).model).get(id);
    return pill && rdf.namedNode(pill.iri);
}

export function viewTerm(g: ModelGraph, id: string): NamedNode | undefined {
    const t = elementTerm(id);
    return t?.termType === 'NamedNode' && g.isView(t) ? t : undefined;
}

/** Types of marks (spec/ui-manifest.hs §2.2): elements kept by their placements. */
export const MARK_TYPES = [V.Frame, V.Note, V.FileRef, V.EntityGroup];

/** View-owned elements, by kind: the placement of a mark (its type), of a view (`V.View`: a view reference), of an arrow (`V.arrow`). */
export const VIEW_ELEMENT_TYPES = [...MARK_TYPES, V.View, V.arrow];

/** The element of a placement in a view. */
export function elementOf(g: ModelGraph, view: NamedNode, placement: Term): NamedNode | undefined {
    const e = g.objects(placement, V.element, view)[0];
    return e?.termType === 'NamedNode' ? e : undefined;
}

/**
 * The element id that an id stands for (spec/ui-manifest.hs §2: a placement is not its element): the placement of a card gives
 * its element, the placement of a relation gives the relation. Other ids stay: an element id, and the placement of a mark, a view
 * or an arrow (the read model identifies these by their placement).
 */
export function elementIdOf(g: ModelGraph, id: string): string {
    const t = elementTerm(id);
    const view = t && g.match(t, P.type, V.Placement).find(q => g.isView(q.graph))?.graph;
    if (!t || !view) return id;
    const e = elementOf(g, view as NamedNode, t);
    if (e) return markType(g, e) || g.isView(e) ? id : elementId(e);
    const c = g.connectorOf(t, view);
    return c && !c.predicate.equals(V.arrow) ? relationId(c.subject as NamedNode, c.predicate as NamedNode, c.object as NamedNode) : id;
}

/** The type of a mark (MARK_TYPES), or undefined. */
export function markType(g: ModelGraph, e: Term): NamedNode | undefined {
    return MARK_TYPES.find(t => g.match(e as NamedNode, P.type, t).length > 0);
}

/** Kind of a placement: the type of its mark, `V.View` for a placement of a view, `V.arrow` for an arrow, undefined for a card or relation. */
export function placementKind(g: ModelGraph, view: NamedNode, placement: Term): NamedNode | undefined {
    const e = elementOf(g, view, placement);
    if (!e) return g.connectorOf(placement, view)?.predicate.equals(V.arrow) ? V.arrow : undefined;
    return g.isView(e) ? V.View : markType(g, e);
}

/** The graph that holds the statements of a mark (its type statement). */
function markGraph(g: ModelGraph, mark: NamedNode): NamedNode {
    return g.match(mark, P.type).find(q => MARK_TYPES.some(t => t.equals(q.object)))!.graph as NamedNode;
}

/** A view-owned element of one of `types` in a view graph: a placement whose kind is in `types`, or an arrow. */
export function viewElementTerm(g: ModelGraph, view: NamedNode, id: string, types = VIEW_ELEMENT_TYPES): NamedNode | undefined {
    const t = elementTerm(id);
    if (t?.termType !== 'NamedNode') return undefined;
    if (!g.has(rdf.quad(t, P.type, V.Placement, view))) return undefined;
    const kind = placementKind(g, view, t);
    return kind && types.some(x => x.equals(kind)) ? t : undefined;
}

/** A new mark of `type` in a view graph, with its content statements. */
function newMark(g: ModelGraph, view: NamedNode, type: NamedNode, content: [NamedNode, Quad_Object][]): NamedNode {
    const m = g.markIri(view);
    g.add(m, P.type, type, view);
    for (const [p, o] of content) g.add(m, p, o, view);
    return m;
}

/** A new placement of an element in a view, with a box. */
function newPlacement(g: ModelGraph, view: NamedNode, element: NamedNode, box: Partial<Box>, color?: string): NamedNode {
    const p = addPlacement(g, view, element);
    writeBox(g, view, p, box);
    if (color) writeString(g, view, p, V.color, color);
    return p;
}

/** Remove a placement. A mark or an arrow without placements is deleted (spec/ui-manifest.hs §2.2, kept by placements). */
export function removePlacement(g: ModelGraph, view: NamedNode, placement: Quad_Subject): void {
    const e = elementOf(g, view, placement);
    const t = g.connectorOf(placement, view);
    const arrow = t?.predicate.equals(V.arrow) ? [t.subject, t.object] : undefined;
    g.removeMatches(placement, null, null, view);
    if (e && markType(g, e) && g.match(null, V.element, e).length === 0) g.removeMatches(e, null, null, markGraph(g, e));
    if (arrow?.[0] && arrow[1] && !arrowPlacements(g, arrow[0], arrow[1]).length) g.removeMatches(arrow[0], V.arrow, arrow[1]);
}

/** The placements of the arrow `s view:arrow o`, in all views. */
function arrowPlacements(g: ModelGraph, s: Term, o: Term): Quad[] {
    return g.match(null, P.reifies, rdf.quad(s as Quad_Subject, V.arrow, o as Quad_Object)).filter(q => g.has(rdf.quad(q.subject, P.type, V.Placement, q.graph)));
}

export function relationTerms(g: ModelGraph, id: string): { s: NamedNode; p: NamedNode; o: NamedNode } | undefined {
    const r = relationTriple(id);
    return r && g.isInstance(r.s) && g.isInstance(r.o) && g.has(rdf.quad(r.s, r.p, r.o, g.homeOf(r.s))) ? r : undefined;
}

export function typesOf(g: ModelGraph, s: Term): string[] {
    return g.objects(s, P.type).map(t => t.value).sort();
}

/** Concept `o` is in scheme or collection `set` (skos:inScheme, skos:topConceptOf, skos:hasTopConcept, skos:member; any graph). */
export function inValueSet(g: ModelGraph, set: string, o: NamedNode): boolean {
    const v = rdf.namedNode(set), k = (l: string) => rdf.namedNode(NS.skos + l);
    return g.match(o, k('inScheme'), v).length > 0 || g.match(o, k('topConceptOf'), v).length > 0
        || g.match(v, k('hasTopConcept'), o).length > 0 || g.match(v, k('member'), o).length > 0;
}

/** Why the shapes do not allow the relation (s, p, o), if they do not. */
function relationProblem(g: ModelGraph, meta: Classes, s: NamedNode, p: string, o: NamedNode): string | undefined {
    if (s.equals(o)) return 'A relation from an element to itself is not supported.';
    // A scheme or collection target: `o` must be in it now (the metamodel list can be older than a concept created in this command).
    const permitted = permittedRelations(meta, typesOf(g, s), typesOf(g, o)).filter(r => !r.valueSet || inValueSet(g, r.valueSet, o));
    if (!permitted.some(r => r.path === p)) return `The schema does not permit this relation from "${g.label(s)}" to "${g.label(o)}".`;
    return undefined;
}

/**
 * A new placement of `placed` in a view (graph.ts `placementIri`): its type, its view and what it places, `view:element` for an
 * element and `rdf:reifies` for a triple (a connector).
 */
export function addPlacement(g: ModelGraph, view: NamedNode, placed: NamedNode | Quad): NamedNode {
    const p = placementIri(view.value, placed);
    g.add(p, P.type, V.Placement, view);
    g.add(p, V.view, view, view);
    if (placed.termType === 'Quad') g.add(p, P.reifies, placed, view); else g.add(p, V.element, placed, view);
    return p;
}

// ------------------------------------------------------------------ identity

const IRI_SYNTAX = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]*$/;

export function iriProblem(g: ModelGraph, iri: string, self?: Term): string | undefined {
    if (!IRI_SYNTAX.test(iri)) return 'Not an absolute IRI.';
    if (g.usedIris(self).has(iri)) return 'This IRI is already used by another element or by the model graph.';
    return undefined;
}

/** Mint an IRI from a label that no other element uses: "label", then "label-2", "label-3", ... */
export function mintFree(g: ModelGraph, label: string, self?: Term): string {
    const used = g.usedIris(self);
    let iri = mint(label);
    for (let i = 2; used.has(iri); i++) iri = mint(`${label}-${i}`);
    return iri;
}

/**
 * Replace a term in every quad (subject, object and graph position), except the quads that `skip` keeps. A new quad stays in the files
 * of the quad that it replaces.
 */
export function replaceTerm(g: ModelGraph, from: NamedNode, to: NamedNode, skip?: (q: Quad) => boolean): void {
    // In a triple term (a placement of a connector), the ends change; the predicate changes with the data (migration).
    const inTriple = (t: Term): boolean => t.termType === 'Quad' && [t.subject, t.object].some(x => x.equals(from) || inTriple(x));
    const quads = rdf.dataset([
        ...g.match(from), ...g.match(null, null, from), ...g.match(null, null, null, from), ...g.match(null, P.reifies).filter(q => inTriple(q.object))
    ].filter(q => !skip?.(q)));
    const swap = <T extends Term>(t: T): T => (t.equals(from) ? to as unknown as T
        : t.termType === 'Quad' ? rdf.quad(swap(t.subject as Quad_Subject), t.predicate as Quad_Predicate, swap(t.object as Quad_Object)) as unknown as T : t);
    for (const q of quads) g.remove(q);
    for (const q of quads) g.add(swap(q.subject), q.predicate, swap(q.object), swap(q.graph), q);
    renameViewElements(g, from, to);
}

/**
 * Keep the IRI rule of view elements (graph.ts) after `from` became `to`. A placement `<view>/p/…` that places `to` (or a triple with
 * it) gets the IRI of what it places now. The placements and marks of a view `from` get the prefix of `to`. Other IRIs stay.
 */
function renameViewElements(g: ModelGraph, from: NamedNode, to: NamedNode): void {
    const has = (t: Term): boolean => t.equals(to) || (t.termType === 'Quad' && (has(t.subject) || has(t.object)));
    const fromM = viewPartBase(from.value, 'm');
    for (const view of g.views()) {
        for (const q of g.match(null, P.type, null, view)) {
            const e = q.subject as NamedNode;
            let next: NamedNode | undefined;
            if (q.object.equals(V.Placement)) {
                const placed = [...g.objects(e, V.element, view), ...g.objects(e, P.reifies, view)][0];
                const ours = e.value.startsWith(viewPartBase(view.value, 'p')) || e.value.startsWith(viewPartBase(from.value, 'p'));
                if (placed && ours && (has(placed) || view.equals(to))) next = placementIri(view.value, placed);
            } else if (e.value.startsWith(fromM)) next = rdf.namedNode(viewPartBase(to.value, 'm') + e.value.slice(fromM.length));
            if (next && !next.equals(e)) replaceTerm(g, e, next);
        }
    }
}

// ------------------------------------------------------------------ instances

/** New instance. `inScheme`: a SKOS concept of this scheme (skos:inScheme, and skos:prefLabel as the SKOS label). */
export function createInstance(g: ModelGraph, classIri: string, label: string, inScheme?: string): Result<string> {
    const problem = labelProblem(label);
    if (problem) return fail(problem);
    const s = rdf.namedNode(mintFree(g, label));
    g.add(s, P.type, rdf.namedNode(classIri));
    g.add(s, P.label, rdf.literal(label));
    if (inScheme) {
        g.add(s, rdf.namedNode(NS.skos + 'prefLabel'), rdf.literal(label));
        g.add(s, rdf.namedNode(NS.skos + 'inScheme'), rdf.namedNode(inScheme));
    }
    return ok(elementId(s));
}

const PREF_LABEL = rdf.namedNode(NS.skos + 'prefLabel');
/** Label predicates, in the order in which the read model takes the label. */
const LABELS = [P.label, PREF_LABEL, rdf.namedNode(NS.sh + 'name')];

/**
 * Write the label of `s`: every label predicate that `like` has (in the graphs where it has it), else `first`. So a SKOS subject
 * with only skos:prefLabel gets no rdfs:label, and an instance with both keeps both equal.
 */
export function writeLabel(g: ModelGraph, s: NamedNode, label: Literal, first: { predicate: NamedNode; graph: NamedNode }, like: NamedNode = s): void {
    const present = LABELS.flatMap(p => g.match(like, p, null, null).map(q => ({ predicate: p, graph: q.graph as NamedNode })));
    const done = new Set<string>();
    for (const { predicate, graph } of present.length ? present : [first]) {
        if (done.has(predicate.value + ' ' + graph.value)) continue;
        done.add(predicate.value + ' ' + graph.value);
        g.set(s, predicate, label, graph);
    }
}

/**
 * Set the IRI of an instance or view. Empty (undefined or '') mints a new IRI from the current label.
 * Returns the new element id (the id follows the IRI).
 */
export function setUri(g: ModelGraph, id: string, uri: string | undefined): Result<string> {
    const view = viewTerm(g, id);
    const el = instanceTerm(g, id) ?? view;
    if (!el) return gone('element', id);
    const value = uri?.trim() || mintFree(g, view ? g.label(g.viewSubject(view)!, view) : g.label(el), el);
    if (value === el.value) return ok(id);
    const problem = iriProblem(g, value, el);
    if (problem) return fail(problem);
    const to = rdf.namedNode(value);
    replaceTerm(g, el, to);
    return ok(elementId(to));
}

/**
 * Replace the statements (s, p, *) of an instance for the given predicates. An IRI object that is an instance
 * is a relation: the shapes must permit it. rdfs:label must stay one valid label. rdf:type is not changed.
 */
export function setStatements(g: ModelGraph, meta: Classes, id: string, values: Record<string, TermJSON[]>): Result {
    const s = instanceTerm(g, id);
    if (!s) return gone('instance', id);
    for (const [p, objects] of Object.entries(values)) {
        if (p === RDF_TYPE) return fail('The form does not change rdf:type.');
        if (p === RDFS_LABEL) {
            const labels = objects.filter(o => o.termType === 'Literal');
            if (labels.length !== 1) return fail('An instance has exactly one label.');
            const problem = labelProblem(labels[0].value);
            if (problem) return fail(problem);
        }
        for (const o of objects) {
            const t = jsonToTerm(o);
            const problem = g.isInstance(t) && relationProblem(g, meta, s, p, t);
            if (problem) return fail(problem);
        }
        const predicate = rdf.namedNode(p), home = g.homeOf(s);
        const keep = rdf.termSet(objects.map(jsonToTerm));
        for (const q of [...g.match(s, predicate, null, home)]) {
            if (keep.has(q.object)) continue;
            g.remove(q);
            if (g.isInstance(q.object)) removeEdgeLayouts(g, s, predicate, q.object);
        }
        for (const o of keep) g.add(s, predicate, o, home);
    }
    return ok(undefined);
}

/**
 * New instance with the types and field values of another one and a new label. The IRI is minted from the label.
 * Relations (IRI objects that are instances) are not copied. Blank-node values are copied with new blank nodes.
 */
export function copyInstance(g: ModelGraph, id: string, label: string): Result<string> {
    const s = instanceTerm(g, id);
    if (!s) return gone('instance', id);
    const problem = labelProblem(label);
    if (problem) return fail(problem);
    const copy = rdf.namedNode(mintFree(g, label));
    // The copy goes to the graph of the source (a concept of a shapes file stays in that file).
    const home = g.homeOf(s);
    // An owned object `<from>-x` is copied as `<to>-x`.
    const copyTree = (from: Quad_Subject, to: NamedNode): void => {
        for (const q of [...g.match(from, null, null, home)]) {
            if (from.equals(s) && (q.predicate.equals(P.label) || q.predicate.equals(PREF_LABEL) || g.isInstance(q.object))) continue;
            if (g.ownedBy(q.object, from, home)) {
                const o = skolemIri();
                copyTree(q.object, o);
                g.add(to, q.predicate, o, home);
            } else {
                g.add(to, q.predicate, q.object, home);
            }
        }
    };
    copyTree(s, copy);
    writeLabel(g, copy, rdf.literal(label), { predicate: P.label, graph: home }, s);
    return ok(elementId(copy));
}

/** Remove the quads of a subject in a graph, and of the objects that it owns (`ModelGraph.ownedBy`). */
export function removeTree(g: ModelGraph, s: Term, graph: Term): void {
    const owned = g.match(s, null, null, graph).map(q => q.object).filter(o => g.ownedBy(o, s, graph));
    g.removeMatches(s, null, null, graph);
    for (const o of owned) removeTree(g, o, graph);
}

/** Remove the instance, every triple where it is subject or object, and all view references. */
export function deleteInstance(g: ModelGraph, id: string): void {
    const s = instanceTerm(g, id);
    if (!s) return;
    const home = g.homeOf(s);
    removeTree(g, s, home);
    g.removeMatches(null, null, s, g.model);
    // A SKOS subject of a shapes file: also the statements of that file that refer to it (skos:broader, skos:member, …), not RDF list cells.
    if (!home.equals(g.model)) for (const q of g.match(null, null, s, home)) if (!q.predicate.equals(RDF_FIRST)) g.remove(q);
    for (const view of g.views()) dropFromView(g, view, s);
}

/** Remove the node of an instance (or node shape), its edge layouts and its collection membership from one view graph. */
export function dropFromView(g: ModelGraph, view: NamedNode, s: NamedNode): void {
    const node = g.nodeOf(view, s);
    if (node) removeTree(g, node, view);
    g.removeMatches(null, V.member, s, view);
    for (const c of g.connectorPlacements(view)) if (c.triple.subject.equals(s) || c.triple.object.equals(s)) removeTree(g, c.placement, view);
}

// ------------------------------------------------------------------ view membership and layout

export function readBox(g: ModelGraph, view: Term, s: Term, fallback = DEFAULT_SIZE): Box {
    return {
        x: g.number(s, V.x, view, 0), y: g.number(s, V.y, view, 0),
        width: g.number(s, V.width, view, fallback.width), height: g.number(s, V.height, view, fallback.height)
    };
}

export function writeBox(g: ModelGraph, view: NamedNode, s: Quad_Subject, box: Partial<Box>): void {
    for (const k of ['x', 'y', 'width', 'height'] as const) {
        const v = box[k];
        if (typeof v === 'number' && isFinite(v)) g.set(s, V[k], integer(v), view);
    }
}

function writeString(g: ModelGraph, view: NamedNode, s: Quad_Subject, p: NamedNode, v: string | undefined): void {
    g.set(s, p, v ? rdf.literal(v) : undefined, view);
}

/** Size of a new node shape card (name and target class); the card grows with its rows. */
export const SHAPE_CARD_SIZE = { width: 520, height: 120 };
/** Size of a value set node (concepts as chips) and of the target node of a property drawn out of its card. */
export const VALUE_SET_SIZE = { width: 320, height: 160 };
export function shapesCardSize(g: ModelGraph, id: string): { width: number; height: number } {
    const idx = shapesIndex(g);
    const property = idx.model.properties[id];
    return idx.valueSet.has(id) ? VALUE_SET_SIZE : property ? targetSize(idx.model, property, alternativesOf(property.range).length) : SHAPE_CARD_SIZE;
}

/** Size of a new card: a shape element or a value set (also a scheme or collection in a data file) as `shapesCardSize`, else DEFAULT_SIZE. */
export function cardSize(g: ModelGraph, id: string): { width: number; height: number } {
    if (shapeCardTerm(g, id) || shapesIndex(g).valueSet.has(id)) return shapesCardSize(g, id);
    const model = shapesIndex(g).model, pill = !instanceTerm(g, id) && pills(model).get(id);
    return pill ? pillSize(rangeText(model, pill.range)) : DEFAULT_SIZE;
}

export function addToView(g: ModelGraph, viewId: string, instanceId: string, at: { x: number; y: number }, size?: { width: number; height: number }): Result {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    size ??= cardSize(g, instanceId);
    const s = cardTerm(g, instanceId);
    if (!s) return fail('A view shows instances, node shapes, concept schemes, collections, properties with an IRI and pills.');
    if (g.nodeOf(view, s)) return fail(`"${g.label(s)}" is already in view "${g.label(g.viewSubject(view)!, view)}".`);
    const node = addPlacement(g, view, s);
    writeBox(g, view, node, { ...at, ...size });
    return ok(undefined);
}

/** The placement of a connector (a relation, an arrow) in a view; a new one if there is none. */
function placeConnector(g: ModelGraph, view: NamedNode, s: NamedNode, p: NamedNode, o: NamedNode): Quad_Subject {
    const found = g.edgeOf(view, s, p, o);
    if (found) return found;
    const e = addPlacement(g, view, rdf.quad(s, p, o));
    return e;
}

function removeEdgeLayouts(g: ModelGraph, s: Term, p: Term, o: Term): void {
    for (const view of g.views()) {
        const e = g.edgeOf(view, s, p, o);
        if (e) removeTree(g, e, view);
    }
}

/**
 * Sides or color of a relation in one view ('' / undefined remove the value). `hidden`: true removes the placement of the relation,
 * false places it (spec/ui-manifest.hs §2.8: no hidden state).
 */
export function setEdgeLayout(g: ModelGraph, viewId: string, relationId: string, patch: Partial<Omit<EdgeLayout, 'relation'>>): Result {
    const view = viewTerm(g, viewId), r = relationTerms(g, relationId);
    if (!view) return gone('view', viewId);
    if (!r) return gone('relation', relationId);
    if (patch.hidden) {
        const e = g.edgeOf(view, r.s, r.p, r.o);
        if (e) removeTree(g, e, view);
        return ok(undefined);
    }
    const e = placeConnector(g, view, r.s, r.p, r.o);
    for (const k of ['fromSide', 'toSide', 'color'] as const) if (k in patch) writeString(g, view, e, V[k], patch[k]);
    return ok(undefined);
}

export function hideEdge(g: ModelGraph, viewId: string, relationId: string, hidden: boolean): Result {
    return setEdgeLayout(g, viewId, relationId, { hidden });
}

const isInstanceTerm = (g: ModelGraph, t: Term): t is NamedNode =>
    t.termType === 'NamedNode' && (g.match(t as NamedNode, P.type, null, g.model).length > 0 || g.match(t as NamedNode, P.label, null, g.model).length > 0);

/** A statement of the model graph that the read model shows as a relation: both ends are instances, not rdf:type or rdfs:label. */
function isRelation(g: ModelGraph, q: Quad): boolean {
    return q.graph.equals(g.model) && !q.predicate.equals(P.type) && !q.predicate.equals(P.label)
        && isInstanceTerm(g, q.subject) && isInstanceTerm(g, q.object) && g.has(q);
}

/** A connector (spec/ui-manifest.hs §2.8): a relation of the model graph, or an arrow (`x view:arrow y`, in a view graph). */
function isConnector(g: ModelGraph, q: Quad): boolean {
    return q.predicate.equals(V.arrow) ? g.has(q) && q.object.termType === 'NamedNode' : isRelation(g, q);
}

/**
 * Runs after each command (spec/ui-manifest.hs §2.8). A new placement of an element places its connectors (relations, arrows) to the
 * elements already placed in that view. A new connector is placed in every view that places both ends.
 */
export function placeConnectors(g: ModelGraph): void {
    const placed: { view: NamedNode; s: NamedNode }[] = [];
    const relations: Quad[] = [];
    for (const c of g.changes()) {
        if (c.op !== 'add') continue;
        const q = c.quad;
        if (q.predicate.equals(V.element) && q.object.termType === 'NamedNode' && q.graph.termType === 'NamedNode') placed.push({ view: q.graph, s: q.object });
        else if (q.graph.equals(g.model) || q.predicate.equals(V.arrow)) relations.push(q);
    }
    for (const { view, s } of placed) {
        if (!g.nodeOf(view, s)) continue;
        const touching = [...g.match(s, null, null, g.model), ...g.match(null, null, s, g.model), ...g.match(s, V.arrow), ...g.match(null, V.arrow, s)];
        for (const q of touching) {
            const other = q.subject.equals(s) ? q.object : q.subject;
            if (other.termType === 'NamedNode' && g.nodeOf(view, other) && isConnector(g, q)) placeConnector(g, view, q.subject as NamedNode, q.predicate as NamedNode, q.object as NamedNode);
        }
    }
    for (const q of relations) {
        if (!isConnector(g, q)) continue;
        for (const view of g.views()) {
            if (g.nodeOf(view, q.subject) && g.nodeOf(view, q.object)) placeConnector(g, view, q.subject as NamedNode, q.predicate as NamedNode, q.object as NamedNode);
        }
    }
}

// ------------------------------------------------------------------ relations

export function createRelation(g: ModelGraph, meta: Classes, subject: string, predicate: string, object: string): Result<string> {
    const s = instanceTerm(g, subject), o = instanceTerm(g, object);
    if (!s) return gone('instance', subject);
    if (!o) return gone('instance', object);
    const problem = relationProblem(g, meta, s, predicate, o);
    if (problem) return fail(problem);
    const p = rdf.namedNode(predicate);
    if (g.has(rdf.quad(s, p, o, g.homeOf(s)))) return fail('This relation exists already.');
    g.add(s, p, o, g.homeOf(s));
    return ok(relationId(s, p, o));
}

/**
 * Move one end of a relation to another instance (the predicate stays). A placement of the relation stays in each view that places
 * both new ends, without the side of the moved end; in other views it is removed. Returns the new relation id.
 */
export function reconnectRelation(g: ModelGraph, meta: Classes, id: string, end: 'source' | 'target', to: string): Result<string> {
    const r = relationTerms(g, id);
    if (!r) return gone('relation', id);
    const t = instanceTerm(g, to);
    if (!t) return gone('instance', to);
    const s = end === 'source' ? t : r.s, o = end === 'target' ? t : r.o;
    if (s.equals(r.s) && o.equals(r.o)) return ok(id);
    const problem = relationProblem(g, meta, s, r.p.value, o);
    if (problem) return fail(problem);
    if (g.has(rdf.quad(s, r.p, o, g.homeOf(s)))) return fail('This relation exists already.');
    g.remove(rdf.quad(r.s, r.p, r.o, g.homeOf(r.s)));
    g.add(s, r.p, o, g.homeOf(s));
    for (const view of g.views()) {
        const e = g.edgeOf(view, r.s, r.p, r.o);
        if (!e) continue;
        if (!g.nodeOf(view, s) || !g.nodeOf(view, o)) {
            removeTree(g, e, view);
            continue;
        }
        g.set(e, P.reifies, rdf.quad(s, r.p, o), view);
        g.set(e, end === 'source' ? V.fromSide : V.toSide, undefined, view);
    }
    return ok(relationId(s, r.p, o));
}

export function deleteRelation(g: ModelGraph, id: string): void {
    const r = relationTerms(g, id);
    if (!r) return;
    g.remove(rdf.quad(r.s, r.p, r.o, g.homeOf(r.s)));
    removeEdgeLayouts(g, r.s, r.p, r.o);
}

// ------------------------------------------------------------------ views

/** A new view. */
export function createView(g: ModelGraph, label: string): Result<string> {
    const problem = labelProblem(label);
    if (problem) return fail(problem);
    const view = rdf.namedNode(mintFree(g, label));
    g.add(view, P.type, V.View, view);
    g.add(view, P.label, rdf.literal(label), view);
    return ok(elementId(view));
}

/** A new view with the layout of another one. Blank nodes are copied, so groups get new ids. */
export function duplicateView(g: ModelGraph, id: string): Result<string> {
    const source = viewTerm(g, id);
    if (!source) return gone('view', id);
    const subject = g.viewSubject(source)!;
    const copy = createView(g, `${g.label(subject, source)} copy`);
    if (!copy.ok) return copy;
    const target = viewTerm(g, copy.value)!;
    const description = g.match(subject, V.description, null, source)[0]?.object;
    if (description) g.set(target, V.description, description, target);
    // Each element of the view graph gets a new IRI in the copy; references between elements follow.
    // Marks first: a placement IRI derives from what it places, and a placement can place a mark (or an arrow between marks).
    const map = rdf.termMap<Term, NamedNode>();
    const typed = g.match(null, P.type, null, source).filter(q => !q.subject.equals(subject));
    for (const q of typed) if (!q.object.equals(V.Placement) && !map.has(q.subject)) map.set(q.subject, g.markIri(target));
    // Also inside triple terms: an arrow between two marks of the view reifies a triple of their new IRIs.
    const t = <T extends Term>(x: T): T => mapTerm(x, y => map.get(y) ?? y);
    for (const q of typed) {
        if (!q.object.equals(V.Placement) || map.has(q.subject)) continue;
        const placed = [...g.objects(q.subject, V.element, source), ...g.objects(q.subject, P.reifies, source)][0];
        if (placed) map.set(q.subject, placementIri(target.value, t(placed)));
    }
    for (const q of [...g.match(null, null, null, source)]) {
        if (q.subject.equals(subject)) continue;
        g.add(t(q.subject), q.predicate, q.predicate.equals(V.view) ? target : t(q.object), target);
    }
    return copy;
}

export function deleteView(g: ModelGraph, id: string): void {
    const view = viewTerm(g, id);
    if (!view) return;
    // Placements of this view in other views (view references) go before the view disappears.
    for (const source of g.views()) if (!source.equals(view)) for (const ref of g.subjects(V.element, view, source)) removePlacement(g, source, ref);
    g.removeMatches(null, null, null, view);
}

// ------------------------------------------------------------------ groups (layout only)

export function createGroup(g: ModelGraph, viewId: string, label: string, rect: Box, color?: string): Result<string> {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    if (!label.trim()) return fail('The group name is empty.');
    const frame = newMark(g, view, V.Frame, [[P.label, rdf.literal(label.trim())]]);
    const b = newPlacement(g, view, frame, { x: rect.x, y: rect.y, width: Math.max(MIN_GROUP.width, rect.width), height: Math.max(MIN_GROUP.height, rect.height) }, color);
    return ok(elementId(b));
}

// ------------------------------------------------------------------ notes and view references (view only)

export function createNote(g: ModelGraph, viewId: string, text: string, at: { x: number; y: number }): Result<string> {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    const note = newMark(g, view, V.Note, [[V.text, rdf.literal(text)]]);
    return ok(elementId(newPlacement(g, view, note, { ...at, ...DEFAULT_NOTE_SIZE })));
}

export function createViewReference(g: ModelGraph, viewId: string, targetId: string, at: { x: number; y: number }): Result<string> {
    const view = viewTerm(g, viewId), target = viewTerm(g, targetId);
    if (!view) return gone('view', viewId);
    if (!target) return gone('view', targetId);
    // A view reference is a placement of the view (spec/ui-manifest.hs §2.1). A view places it once.
    if (g.nodeOf(view, target)) return fail(`View "${g.label(target, target)}" is already in view "${g.label(view, view)}".`);
    return ok(elementId(newPlacement(g, view, target, { ...at, ...DEFAULT_VIEW_REFERENCE_SIZE })));
}

/** A link box to a file: `file` is the path relative to the view file (ModelStore makes it relative). */
export function createFileReference(g: ModelGraph, viewId: string, file: string, at: { x: number; y: number }): Result<string> {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    if (!file.trim()) return fail('No file.');
    const ref = newMark(g, view, V.FileRef, [[V.file, rdf.literal(file)]]);
    return ok(elementId(newPlacement(g, view, ref, { ...at, ...DEFAULT_VIEW_REFERENCE_SIZE })));
}

// ------------------------------------------------------------------ any element of a view

/**
 * Change one element of a view: its box, its color, and the field of its kind: display of a card, label of a group, text of a
 * note. A field that the element does not have is ignored. A relation takes only the color (its edge layout).
 * `expectedText` (a note) protects a local editor draft from overwriting another client's change.
 */
/** One guarded edit of the Markdown explanation in the view graph. */
export function setViewDescription(g: ModelGraph, viewId: string, text: string, expectedText?: string): Result {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    const current = g.match(view, V.description, null, view)[0]?.object.value ?? '';
    if (expectedText !== undefined && current !== expectedText) return fail('These notes changed elsewhere. Copy your text before reloading the editor.');
    g.set(view, V.description, text === '' ? undefined : rdf.literal(text), view);
    return ok(undefined);
}

export function setViewElement(g: ModelGraph, viewId: string, id: string, patch: ViewElementPatch, expectedText?: string): Result {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    if (relationTerms(g, id)) return 'color' in patch ? setEdgeLayout(g, viewId, id, { color: patch.color }) : ok(undefined);
    const s = boxSubject(g, view, id) ?? viewElementTerm(g, view, id, [V.arrow]);
    if (!s) return fail('The element is not in this view any more.');
    const arrow = !!placementKind(g, view, s)?.equals(V.arrow);
    const kind = arrow ? undefined : placementKind(g, view, s);
    const mark = kind && !kind.equals(V.View) ? elementOf(g, view, s) : undefined;
    const is = (type: NamedNode) => !!kind && kind.equals(type);
    let box: Partial<Box> = patch;
    if (is(V.Frame)) {
        if (patch.label !== undefined) {
            if (!patch.label.trim()) return fail('The group name is empty.');
            g.set(mark!, P.label, rdf.literal(patch.label.trim()), markGraph(g, mark!));
        }
        box = {
            ...patch,
            width: patch.width === undefined ? undefined : Math.max(MIN_GROUP.width, patch.width),
            height: patch.height === undefined ? undefined : Math.max(MIN_GROUP.height, patch.height)
        };
    }
    if (is(V.Note)) {
        if (expectedText !== undefined && (g.match(mark!, V.text, null)[0]?.object.value ?? '') !== expectedText) {
            return fail('This note changed elsewhere. Copy your draft, then reopen it.');
        }
        if (patch.text !== undefined) g.set(mark!, V.text, rdf.literal(patch.text), markGraph(g, mark!));
    }
    const card = !arrow && !kind;
    if (card && 'display' in patch) writeString(g, view, s, V.display, patch.display === 'simple' ? 'simple' : undefined);
    if (!arrow) writeBox(g, view, s, box);
    if ('color' in patch) writeString(g, view, s, V.color, patch.color);
    return ok(undefined);
}

/**
 * Remove elements from a view. A card leaves the view (the model does not change), the edge of a relation hides, a collection
 * leaves with its members, and a view-owned element is deleted.
 */
export function removeViewElements(g: ModelGraph, viewId: string, ids: string[]): void {
    const view = viewTerm(g, viewId);
    if (!view) return;
    for (const id of ids) {
        const card = cardTerm(g, id);
        if (card) dropFromView(g, view, card);
        else if (relationTerms(g, id)) hideEdge(g, viewId, id, true);
        else {
            const s = viewElementTerm(g, view, id);
            if (!s) continue;
            const e = elementOf(g, view, s);
            if (e && placementKind(g, view, s)?.equals(V.EntityGroup)) for (const m of g.objects(e, V.member, markGraph(g, e))) dropFromView(g, view, m as NamedNode);
            removePlacement(g, view, s);
        }
    }
}

// ------------------------------------------------------------------ arrows (view only)

/**
 * Arrow from one box of a view to another; one end is a note. The arrow is the statement `x view:arrow y` between the elements of the
 * boxes (in the view graph); a placement of it in this view shows it. Returns the id of the placement.
 */
export function createArrow(g: ModelGraph, viewId: string, fromId: string, toId: string): Result<string> {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    const from = boxSubject(g, view, fromId), to = boxSubject(g, view, toId);
    if (!from || !to) return fail('An arrow connects two elements of the view.');
    if (from.equals(to)) return fail('An arrow connects two different elements.');
    const isNote = (b: Term) => !!placementKind(g, view, b)?.equals(V.Note);
    if (!isNote(from) && !isNote(to)) return fail('An arrow starts or ends at a note.');
    const x = elementOf(g, view, from)!, y = elementOf(g, view, to)!;
    if (g.edgeOf(view, x, V.arrow, y)) return fail('This arrow exists already.');
    if (g.match(x, V.arrow, y).length === 0) g.add(x, V.arrow, y, view);
    return ok(elementId(placeConnector(g, view, x, V.arrow, y) as NamedNode));
}

/** Remove the placements of arrows whose ends the view does not place any more (the arrow goes with its last placement). Runs after each command. */
export function pruneArrows(g: ModelGraph): void {
    for (const { placement, triple, view } of g.connectorPlacements()) {
        if (!triple.predicate.equals(V.arrow)) continue;
        const x = triple.subject, y = triple.object;
        if (!shownIn(g, view, x) || !shownIn(g, view, y) || g.match(x as NamedNode, V.arrow, y).length === 0) removePlacement(g, view, placement);
    }
}

/** The view shows the element: its placement, or the placement of an entity group that has it as a member (ADR 0014, C1). */
function shownIn(g: ModelGraph, view: NamedNode, x: Term): boolean {
    return !!g.nodeOf(view, x) || g.match(null, V.member, x).some(q => !!g.nodeOf(view, q.subject));
}

// ------------------------------------------------------------------ collections (view only)

/**
 * A member of an entity group has no placement of its own while it is in the group (ADR 0014, C1): its placement goes, and so do the
 * placements of its relations (the group draws them as bundles). An arrow keeps its placement: it ends at the group.
 */
function unplaceMember(g: ModelGraph, view: NamedNode, m: NamedNode): void {
    const node = g.nodeOf(view, m);
    if (node) removeTree(g, node, view);
    for (const c of g.connectorPlacements(view)) {
        if (!c.triple.predicate.equals(V.arrow) && (c.triple.subject.equals(m) || c.triple.object.equals(m))) removeTree(g, c.placement, view);
    }
}

/** New collection of instances of a view, at `rect`. The instances lose their placements; members of other collections leave them. */
export function createCollection(g: ModelGraph, viewId: string, instanceIds: string[], rect: Box): Result<string> {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    // In the view: a card, or a member of an entity group of the view (it has no placement, ADR 0014 C1).
    const members = instanceIds.map(id => instanceTerm(g, id)).filter((s): s is NamedNode => !!s && (!!g.nodeOf(view, s) || g.match(null, V.member, s, view).length > 0));
    if (members.length === 0) return fail('Select the cards to collect.');
    for (const m of members) for (const q of g.match(null, V.member, m, view)) g.remove(q);
    const group = newMark(g, view, V.EntityGroup, members.map(m => [V.member, m]));
    for (const m of members) unplaceMember(g, view, m);
    return ok(elementId(newPlacement(g, view, group, rect)));
}

/** Instances join a collection. A member has no placement of its own (C1). */
export function addToCollection(g: ModelGraph, viewId: string, id: string, instanceIds: string[]): Result {
    const view = viewTerm(g, viewId);
    const c = view && viewElementTerm(g, view, id, [V.EntityGroup]);
    if (!view || !c) return fail('No such collection.');
    const mark = elementOf(g, view, c)!, graph = markGraph(g, mark);
    const members = instanceIds.map(i => instanceTerm(g, i)).filter((s): s is NamedNode => !!s);
    if (members.length === 0) return fail('No such instance.');
    for (const m of members) {
        unplaceMember(g, view, m);
        g.removeMatches(null, V.member, m, view);
        g.add(mark, V.member, m, graph);
    }
    return ok(undefined);
}

/** Take members (all without `instanceIds`) out of a collection. Their cards go next to it, on the right. An empty collection is deleted. */
export function uncollect(g: ModelGraph, viewId: string, id: string, instanceIds?: string[]): Result<string[]> {
    const view = viewTerm(g, viewId);
    const c = view && viewElementTerm(g, view, id, [V.EntityGroup]);
    if (!view || !c) return fail('No such collection.');
    const mark = elementOf(g, view, c)!, graph = markGraph(g, mark);
    const members = g.objects(mark, V.member, graph).filter(m => !instanceIds || instanceIds.includes(elementId(m as NamedNode))) as NamedNode[];
    const box = readBox(g, view, c, DEFAULT_COLLECTION_SIZE);
    const at = { x: box.x + box.width + 60 + DEFAULT_SIZE.width / 2, y: box.y + box.height / 2 };
    const places = members.length === 1 ? [centered(at)] : gridPositions(members.length, { x: at.x + DEFAULT_SIZE.width / 2, y: at.y });
    // A released member gets its placement again (a file before ADR 0014 can still have one).
    members.forEach((m, i) => {
        g.remove(rdf.quad(mark, V.member, m, graph));
        writeBox(g, view, g.nodeOf(view, m) ?? addPlacement(g, view, m), { ...places[i], ...DEFAULT_SIZE });
    });
    if (g.objects(mark, V.member, graph).length === 0) removePlacement(g, view, c);
    return ok(members.map(m => elementId(m)));
}

const BOX_TYPES = [...MARK_TYPES, V.View];

/** The subject that holds the box of a card (by instance id), group, note, view reference or collection in a view. */
function boxSubject(g: ModelGraph, view: NamedNode, id: string): Quad_Subject | undefined {
    const s = cardTerm(g, id);
    return s ? g.nodeOf(view, s) : viewElementTerm(g, view, id, BOX_TYPES);
}

/** Bounding box around some cards, groups, notes and view references of a view, with a margin (for "group the selection"). */
export function boundsOf(g: ModelGraph, viewId: string, ids: string[], margin = 40): Box | undefined {
    const view = viewTerm(g, viewId);
    if (!view) return undefined;
    const boxes = ids.map(id => boxSubject(g, view, id)).filter(n => !!n)
        .map(n => readBox(g, view, n!, placementKind(g, view, n!)?.equals(V.Frame) ? GROUP_SIZE : DEFAULT_SIZE));
    if (boxes.length === 0) return undefined;
    const x = Math.min(...boxes.map(n => n.x)) - margin, y = Math.min(...boxes.map(n => n.y)) - margin;
    const r = Math.max(...boxes.map(n => n.x + n.width)) + margin, b = Math.max(...boxes.map(n => n.y + n.height)) + margin;
    return { x, y, width: r - x, height: b - y };
}


/**
 * New bounds of cards and groups in a view (one drag or resize). A group that moves with the same size also
 * moves the cards and groups fully inside it, as in JSON Canvas.
 */
export function setBounds(g: ModelGraph, viewId: string, bounds: ({ id: string } & Partial<Box>)[]): Result {
    const view = viewTerm(g, viewId);
    if (!view) return gone('view', viewId);
    // An element drawn without a placement gets one at the place where it was moved (an "in" or "one of" box: its list term).
    for (const b of bounds) {
        const s = cardTerm(g, b.id);
        if (s && !g.nodeOf(view, s)) addToView(g, viewId, b.id, { x: 0, y: 0 });
    }
    const moved = rdf.termSet<Quad_Subject>();
    for (const b of bounds) {
        const s = boxSubject(g, view, b.id);
        if (s) moved.add(s);
    }
    const members = g.subjects(P.type, V.Placement, view).filter(n => g.objects(n, V.element, view).length > 0);
    for (const b of bounds) {
        const grp = viewElementTerm(g, view, b.id, [V.Frame]);
        if (!grp || b.x === undefined || b.y === undefined) continue;
        const box = readBox(g, view, grp, GROUP_SIZE);
        if ((b.width !== undefined && b.width !== box.width) || (b.height !== undefined && b.height !== box.height)) continue;
        const dx = b.x - box.x, dy = b.y - box.y;
        for (const m of members) {
            if (moved.has(m) || m.equals(grp)) continue;
            const mb = readBox(g, view, m);
            if (!inside(mb, box)) continue;
            writeBox(g, view, m, { x: mb.x + dx, y: mb.y + dy });
            moved.add(m);
        }
    }
    for (const b of bounds) {
        const s = boxSubject(g, view, b.id);
        if (!s) continue;
        const isGroup = !!placementKind(g, view, s)?.equals(V.Frame);
        writeBox(g, view, s, isGroup ? {
            ...b,
            width: b.width === undefined ? undefined : Math.max(MIN_GROUP.width, b.width),
            height: b.height === undefined ? undefined : Math.max(MIN_GROUP.height, b.height)
        } : b);
    }
    return ok(undefined);
}


