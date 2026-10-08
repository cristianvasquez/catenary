// EditCommand (@catenary/model) -> operations on the quads. No I/O, no undo (the store records the patch).
// This is the only edit path.

import { Box, Classes, DEFAULT_COLLECTION_SIZE, DEFAULT_SIZE, DEFAULT_VIEW_REFERENCE_SIZE, EdgeSides, EditCommand, boxes, Point, ViewClip, centered, gridPositions, isViewClip, nextLabel, rangeOfShape, selection, valueSetOf } from '@catenary/model';
import type { NamedNode } from '@rdfjs/types';
import { ModelGraph, P } from './graph';
import { elementId, relationId } from './ids';
import { deleteElements, renameElement } from './elements';
import * as ops from './ops';
import * as shapes from './shape-ops';
import { proposeShapes } from './shape-proposal';
import { figureTermOf, showAsLine, syncFigures } from './figure-edits';
import { rdf } from './terms';
import { readView } from './view-read';

const { ok, fail } = ops;
const done = ok(undefined);
function withSides(g: ModelGraph, view: string | undefined, sides: EdgeSides | undefined, r: ops.Result<string>): ops.Result<string> {
    if (!r.ok || !view || !sides || !ops.viewTerm(g, view)) return r;
    const s = ops.setEdgeLayout(g, view, r.value, sides);
    return s.ok ? r : s;
}

/** Card id of an IRI in this model, if the IRI is an instance or a node shape. */
function instanceId(g: ModelGraph, iri: string): string | undefined {
    const t = rdf.namedNode(iri);
    return g.isInstance(t) || shapes.nodeShapeTerm(g, elementId(t)) ? elementId(t) : undefined;
}

/**
 * The command with the ids of placements of cards and relations replaced by the ids of their elements (`ops.elementIdOf`). A
 * selection on a canvas holds placements; the operations act on elements, and find the placement of an element in a view.
 */
function elementIds(g: ModelGraph, c: EditCommand): EditCommand {
    const id = (x: unknown) => typeof x === 'string' ? ops.elementIdOf(g, x) : x;
    const out: Record<string, unknown> = { ...c };
    for (const k of ['id', 'relation', 'subject', 'object', 'from', 'to']) if (k in out) out[k] = id(out[k]);
    for (const k of ['ids', 'clearSides']) if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(id);
    if (Array.isArray(out.bounds)) out.bounds = (out.bounds as { id: string }[]).map(b => ({ ...b, id: id(b.id) as string }));
    return out as EditCommand;
}

const triple = (e: ViewClip['edges'][number]) => rdf.quad(rdf.namedNode(e.subject), rdf.namedNode(e.predicate), rdf.namedNode(e.object));

/**
 * Add a clip to a view. Instances not in this model are skipped. Cut clip: the same instances; instances already in the
 * view are skipped. Copy clip: new instances (see ops.copyInstance), with the relations between the copied instances.
 * Groups and notes are new. A view reference to a view that the view already refers to is skipped. Returns the ids of the pasted boxes (a cut: also of the cards already in the view).
 */
function pasteIntoView(g: ModelGraph, viewId: string, clip: ViewClip, at?: Point): ops.Result<string[]> {
    // Boxes of this model: a card of an element of this model, a reference to a view of this model. `id`: its element or target view.
    const items = clip.boxes.flatMap((b): { b: ViewClip['boxes'][number]; id: string }[] => {
        if (b.kind === 'card') return instanceId(g, b.id) ? [{ b, id: instanceId(g, b.id)! }] : [];
        if (b.kind === 'reference') return b.target && g.isView(rdf.namedNode(b.target)) ? [{ b, id: elementId(rdf.namedNode(b.target)) }] : [];
        return [{ b, id: '' }];
    });
    if (items.length === 0) return fail('The copied elements do not exist in this model.');
    const dx = at ? at.x - Math.min(...items.map(i => i.b.x)) : 0;
    const dy = at ? at.y - Math.min(...items.map(i => i.b.y)) : 0;
    const view = ops.viewTerm(g, viewId)!;
    const copy = clip.mode === 'copy';
    // A view places an element once: a card of a cut, and a reference (copy or cut), already in the view, are skipped.
    const inView = items.filter(({ b }) => (b.kind === 'card' && !copy && !!g.nodeOf(view, rdf.namedNode(b.id))) || (b.kind === 'reference' && !!g.nodeOf(view, rdf.namedNode(b.target!))));
    if (inView.length === items.length) return alreadyInView(items.length);
    // Copy: IRI of the source instance -> its copy.
    const copies = rdf.termMap<NamedNode, NamedNode>();
    const used = new Set(g.match(null, P.label, null, g.model).map(q => q.object.value));
    const pasted: string[] = [];
    for (const { b, id } of items.filter(i => !inView.includes(i))) {
        const place = { x: b.x + dx, y: b.y + dy };
        let r: ops.Result<string | void>;
        let element = id;
        if (b.kind === 'card') {
            // A node shape is not copied: the paste shows the same shape.
            if (copy && ops.instanceTerm(g, id)) {
                const label = nextLabel(g.label(rdf.namedNode(b.id)), used);
                const c = ops.copyInstance(g, id, label);
                if (!c.ok) return c;
                used.add(label);
                element = c.value;
                copies.set(rdf.namedNode(b.id), ops.instanceTerm(g, element)!);
            }
            r = ops.addToView(g, viewId, element, place, { width: b.width, height: b.height });
        } else if (b.kind === 'group') r = ops.createGroup(g, viewId, b.label, { ...place, width: b.width, height: b.height });
        else if (b.kind === 'note') r = ops.createNote(g, viewId, b.text, place);
        else r = ops.createViewReference(g, viewId, id, place);
        if (!r.ok) return r;
        if (b.kind !== 'card') element = r.value as string;
        const s = ops.setViewElement(g, viewId, element, { width: b.width, height: b.height, color: b.color, ...(b.kind === 'card' ? { display: b.display } : {}) });
        if (!s.ok) return s;
        pasted.push(element);
    }
    for (const [source, target] of copies) {
        for (const q of g.match(source, null, null, g.homeOf(source))) {
            const o = copies.get(q.object as NamedNode);
            if (o) g.add(target, q.predicate, o, g.homeOf(target));
        }
    }
    for (const e of clip.edges) {
        const t = triple(e);
        if (!g.isInstance(t.subject) || !g.isInstance(t.object) || !g.has(rdf.quad(t.subject, t.predicate, t.object, g.homeOf(t.subject)))) continue;
        const s = copy ? copies.get(t.subject) : t.subject, o = copy ? copies.get(t.object) : t.object;
        if (!s || !o || g.edgeOf(view, s, t.predicate, o)) continue;
        const { subject: _s, predicate: _p, object: _o, ...layout } = e;
        const r = ops.setEdgeLayout(g, viewId, relationId(s, t.predicate as NamedNode, o), layout);
        if (!r.ok) return r;
    }
    return ok([...pasted, ...inView.map(i => i.id)]);
}

/** The property shape `id` is a line in the view (ADR 0014: its placement, or its hub). */
function isLineIn(g: ModelGraph, viewId: string, id: string): boolean {
    const view = ops.viewTerm(g, viewId), term = figureTermOf(g, id);
    return !!view && !!term && !!g.nodeOf(view, term);
}

/** Add the instances that are not in the view yet: one at `at`, several in a grid around it. Returns the added ids. */
function placeAround(g: ModelGraph, viewId: string, ids: string[], at: Point): string[] {
    const view = ops.viewTerm(g, viewId)!;
    const add = [...new Set(ids)].filter(id => !g.nodeOf(view, ops.cardTerm(g, id)!));
    const places = add.length === 1 ? [centered(at)] : gridPositions(add.length, at);
    add.forEach((id, i) => {
        const size = ops.cardSize(g, id);
        // Grid positions use the data-card size. Keep each center, but use this element's dimensions.
        const at = { x: places[i].x + (DEFAULT_SIZE.width - size.width) / 2, y: places[i].y + (DEFAULT_SIZE.height - size.height) / 2 };
        ops.addToView(g, viewId, id, at, size);
    });
    return add;
}

const alreadyInView = (n: number) => fail(n === 1 ? 'The instance is already in this view. An element appears at most once in each view.'
    : `All ${n} instances are already in this view.`);

/**
 * Commands that place a target from a property (Show as Edge, a new or changed property with its target): the placed box does not
 * arrive (ADR 0014 rule 11, exception). Only that property is a line.
 */
const FROM_A_PROPERTY = new Set<EditCommand['kind']>(['showAsEdge', 'createPropertyShape', 'setPropertyShape']);

export function executeCommand(g: ModelGraph, meta: Classes, c: EditCommand): ops.Result<unknown> {
    const r = run(g, meta, elementIds(g, c));
    // One rule for every removal path: an arrow goes with its end. One rule for every placement path: relations and property edges
    // follow their ends.
    if (r.ok) {
        ops.placeConnectors(g);
        syncFigures(g, !FROM_A_PROPERTY.has(c.kind));
        ops.pruneArrows(g);
    }
    return r;
}

/**
 * The bounds of a move in placed terms: an "in" or "one of" box (`<property element id>_leaf`) is placed by its list term (placed at
 * the first move); a private pill has no placement and does not move.
 */
function boxBounds(g: ModelGraph, bounds: ({ id: string } & Partial<Box>)[]): ({ id: string } & Partial<Box>)[] {
    return bounds.flatMap(b => {
        if (!b.id.endsWith('_leaf')) return [b];
        const term = figureTermOf(g, b.id);
        return term && term.value.startsWith(ops.LIST_PREFIX) ? [{ ...b, id: elementId(term) }] : [];
    });
}

function run(g: ModelGraph, meta: Classes, c: EditCommand): ops.Result<unknown> {
    // A command that names a view needs that view.
    if ('view' in c && c.view !== undefined && !ops.viewTerm(g, c.view)) return ops.gone('view', c.view);
    switch (c.kind) {
        case 'createInstance': {
            const r = ops.createInstance(g, c.classIri, c.label);
            if (r.ok && c.view) placeAround(g, c.view, [r.value], c.at ?? { x: 0, y: 0 });
            return r;
        }
        case 'rename': {
            const r = renameElement(g, c.id, c.label);
            return r.ok && c.targetClass ? shapes.setNodeShape(g, c.id, { targetClass: c.targetClass }) : r;
        }
        case 'setUri':
            // A shape wins (as for cards): a punned IRI changes everywhere except in rdf:type statements of the data (a migration).
            return ops.shapeCardTerm(g, c.id) ? shapes.setShapeUri(g, c.id, c.uri) : ops.setUri(g, c.id, c.uri);
        case 'setViewDescription':
            return ops.setViewDescription(g, c.view, c.text, c.expectedText);
        case 'setStatements':
            return ops.setStatements(g, meta, c.id, c.values);
        case 'delete':
            return deleteElements(g, c.ids);
        case 'addToView': {
            const known = c.ids.filter(id => ops.cardTerm(g, id));
            if (!known.length) return ops.gone('element', c.ids.join(', '));
            const added = placeAround(g, c.view, known, c.at);
            return added.length ? ok(added[0]) : alreadyInView(c.ids.length);
        }
        case 'showRelations': {
            const rels = c.ids.map(id => ops.relationTerms(g, id)).filter(r => !!r);
            if (rels.length === 0) return ops.gone('relation', c.ids.join(', '));
            const added = placeAround(g, c.view, rels.flatMap(r => [elementId(r.s), elementId(r.o)]), c.at);
            for (const id of c.ids) ops.hideEdge(g, c.view, id, false);
            return ok(added[0]);
        }
        case 'showAsEdge': {
            const model = shapes.shapesIndex(g).model;
            if (!model.properties[c.id] && !model.constraints[c.id]) return ops.gone('property shape', c.id);
            const problem = showAsLine(g, c.view, c.id, c.at);
            return problem ? fail(problem) : ok(c.id);
        }
        case 'removeFromView': {
            // A hub, a member line or its pill: the hub unit. An "in" or "one of" box: its list placement. The removal rule (syncFigures)
            // takes the lines that need what left.
            const view = ops.viewTerm(g, c.view)!;
            const rest: string[] = [];
            for (const id of c.ids) {
                const term = figureTermOf(g, id);
                if (term && (id.startsWith('c-') || id.endsWith('_leaf') || term.value.startsWith(ops.LIST_PREFIX))) ops.dropFromView(g, view, term);
                else if (!id.endsWith('_leaf') && !id.startsWith('c-')) rest.push(id);
            }
            ops.removeViewElements(g, c.view, rest);
            return done;
        }
        case 'cutFromView': {
            ops.removeViewElements(g, c.view, selection(readView(g, c.view).views[c.view], c.ids).map(b => b.kind === 'card' ? b.element : b.id));
            return done;
        }
        case 'setBounds':
            return ops.setBounds(g, c.view, boxBounds(g, c.bounds));
        case 'setLayout': {
            const r = ops.setBounds(g, c.view, boxBounds(g, c.bounds));
            if (!r.ok) return r;
            for (const id of c.clearSides) if (ops.relationTerms(g, id)) ops.setEdgeLayout(g, c.view, id, { fromSide: undefined, toSide: undefined });
            return done;
        }
        case 'setEdgeLayout':
            return ops.setEdgeLayout(g, c.view, c.relation, c.patch);
        case 'setViewElements':
            for (const id of c.ids) {
                const r = ops.setViewElement(g, c.view, id, c.patch, c.expectedText);
                if (!r.ok) return r;
            }
            return done;
        case 'hideEdges':
            for (const id of c.ids) if (ops.relationTerms(g, id)) ops.hideEdge(g, c.view, id, c.hidden);
            return done;
        case 'createRelation': {
            const ends: string[] = [];
            for (const end of [c.subject, c.object]) {
                let id = end;
                if (typeof id !== 'string') {
                    const r = ops.createInstance(g, id.classIri, id.label, id.inScheme);
                    if (!r.ok) return r;
                    id = r.value;
                }
                const t = ops.instanceTerm(g, id);
                if (!t) return ops.gone('instance', id);
                if (c.view && ops.viewTerm(g, c.view) && !g.nodeOf(ops.viewTerm(g, c.view)!, t)) ops.addToView(g, c.view, id, centered(c.at ?? { x: 0, y: 0 }));
                ends.push(id);
            }
            return withSides(g, c.view, c.sides, ops.createRelation(g, meta, ends[0], c.predicate, ends[1]));
        }
        case 'reconnectRelation': {
            const r = ops.reconnectRelation(g, meta, c.relation, c.end, c.to);
            if (!r.ok || !c.view || !c.side) return r;
            return withSides(g, c.view, c.end === 'source' ? { fromSide: c.side } : { toSide: c.side }, r);
        }
        case 'createView':
            return ops.createView(g, c.label);
        case 'createNodeShape': {
            const r = shapes.createNodeShape(g, c.label, c.targetClass);
            if (r.ok && c.view) placeAround(g, c.view, [r.value], c.at ?? { x: 0, y: 0 });
            return r;
        }
        case 'proposeShapes':
            return proposeShapes(g, c.classes);
        case 'setNodeShape':
            return shapes.setNodeShape(g, c.id, c.patch);
        case 'createPropertyShape': {
            let range = c.range;
            if (c.newTarget) {
                const t = c.newTarget;
                const made = t.kind === 'nodeShape' ? shapes.createNodeShape(g, t.label) : shapes.createValueSet(g, t.kind, t.label);
                if (!made.ok) return made;
                if (c.view) placeAround(g, c.view, [made.value], c.at ?? { x: 0, y: 0 });
                const r = rangeOfShape(shapes.shapesIndex(g).model, made.value);
                if (!r) return fail('The new target was not created.');
                range = r;
            }
            let owner = c.shape;
            if (c.newOwner !== undefined) {
                const made = shapes.createNodeShape(g, c.newOwner);
                if (!made.ok) return made;
                owner = made.value;
            }
            const r = shapes.createPropertyShape(g, owner, { ...c, range });
            if (r.ok && c.view && c.at && c.out && ops.viewTerm(g, c.view)) {
                placeAround(g, c.view, [owner], c.at);
                showAsLine(g, c.view, r.value, c.at);
            }
            return r;
        }
        case 'setPropertyShape': {
            const r = shapes.setPropertyShape(g, c.id, c.patch);
            // A new end of a line gets its box; a value set also for a row (its concepts are edited on its card).
            const range = c.patch.range, model = shapes.shapesIndex(g).model;
            if (r.ok && c.view && c.at && range && ops.viewTerm(g, c.view)) {
                if (isLineIn(g, c.view, c.id)) showAsLine(g, c.view, c.id, c.at);
                else { const set = valueSetOf(model, range); if (set) placeAround(g, c.view, [set], c.at); }
            }
            return r;
        }
        case 'groupProperties':
            return shapes.groupProperties(g, c.ids, c.operator);
        case 'setConstraint':
            return shapes.setConstraintOperator(g, c.id, c.operator);
        case 'ungroup':
            return shapes.ungroup(g, c.id);
        case 'takeOutOfConstraint':
            return shapes.takeOutOfConstraint(g, c.id);
        case 'createValueSet': {
            const r = shapes.createValueSet(g, c.valueSet, c.label);
            if (r.ok && c.view) placeAround(g, c.view, [r.value], c.at ?? { x: 0, y: 0 });
            return r;
        }
        case 'addConcept':
            return shapes.addConcept(g, c.set, c);
        case 'setConceptBroader':
            return shapes.setConceptBroader(g, c.uri, c.broader);
        case 'removeConcept':
            return shapes.removeConcept(g, c.set, c.uri);
        case 'migrateData':
            return shapes.migrate(g, c.migration);
        case 'duplicateView':
            return ops.duplicateView(g, c.id);
        case 'createGroup': {
            const rect = (c.around?.length ? ops.boundsOf(g, c.view, c.around, 50) : undefined)
                ?? c.rect ?? { x: -400, y: -250, width: 800, height: 500 };
            return ops.createGroup(g, c.view, c.label, rect);
        }
        case 'createNote':
            return ops.createNote(g, c.view, c.text, c.at);
        case 'createArrow':
            return ops.createArrow(g, c.view, c.from, c.to);
        case 'addViewReference':
            return ops.createViewReference(g, c.view, c.target, {
                x: c.at.x - DEFAULT_VIEW_REFERENCE_SIZE.width / 2, y: c.at.y - DEFAULT_VIEW_REFERENCE_SIZE.height / 2
            });
        case 'addFileReference':
            return ops.createFileReference(g, c.view, c.file, {
                x: c.at.x - DEFAULT_VIEW_REFERENCE_SIZE.width / 2, y: c.at.y - DEFAULT_VIEW_REFERENCE_SIZE.height / 2
            });
        case 'collect': {
            const view = readView(g, c.view).views[c.view];
            const joining = boxes(view, 'collection').filter(x => c.ids.includes(x.id));
            const members = [...new Set([...c.ids.filter(id => ops.instanceTerm(g, id)), ...joining.flatMap(x => x.members)])];
            const around: Box[] = [...boxes(view, 'card').filter(n => members.includes(n.element) && !joining.some(x => x.members.includes(n.element))), ...joining];
            if (around.length === 0) return fail('Select the cards to collect.');
            const x0 = Math.min(...around.map(b => b.x)), y0 = Math.min(...around.map(b => b.y));
            const x1 = Math.max(...around.map(b => b.x + b.width)), y1 = Math.max(...around.map(b => b.y + b.height));
            const { width, height } = DEFAULT_COLLECTION_SIZE;
            // The joining collections go; their members stay in the view.
            const v = ops.viewTerm(g, c.view)!;
            for (const x of joining) ops.removeTree(g, ops.viewElementTerm(g, v, x.id)!, v);
            return ops.createCollection(g, c.view, members, { x: (x0 + x1 - width) / 2, y: (y0 + y1 - height) / 2, width, height });
        }
        case 'addToCollection':
            return ops.addToCollection(g, c.view, c.id, c.ids);
        case 'uncollect':
            return ops.uncollect(g, c.view, c.id, c.ids);
        case 'pasteIntoView': {
            if (!isViewClip(c.clip)) return fail('The clipboard does not hold view elements.');
            return pasteIntoView(g, c.view, c.clip, c.at);
        }
        default:
            // A frontend newer than this backend: restart the backend.
            return fail(`Unknown command "${(c as { kind: string }).kind}". The backend is older than the frontend: restart it.`);
    }
}
