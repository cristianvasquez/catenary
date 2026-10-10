// Edit operations on the shapes graphs. As ops.ts: each operation adds and removes quads through ModelGraph (one patch, undo), or
// returns an error. Ids: see ids.ts; shapes-read.ts resolves them to terms. A path rename or a target class change of a shape with data
// adds a proposed migration (ModelGraph.proposed); the store keeps these in its queue until the user applies or dismisses them. When
// the old term has no other shape and the new IRI is new, the change is a rename: the shapes, vocabulary and views follow (renameIri).
// No blank nodes: property shapes, list cells and the shapes of value set ranges get IRIs. A node that belongs to another one is named
// after it (`<owner>-<name>`) and goes with it.

import {
    LogicalOperator, Migration, MigrationChange, NS, NodeShapePatch, PathJSON, PropertyShapePatch, Range, alternativesOf, broaderProblem, formatPath, isValueSetMember, labelProblem, localName, orRange, shortIri
} from '@catenary/model';
import type { NamedNode, Quad, Quad_Graph, Quad_Object, Quad_Subject, Term } from '@rdfjs/types';
import { ModelGraph, P, UsedIris, mint } from './graph';
import { elementId, elementTerm } from './ids';
import { Result, dropFromView, fail, gone, iriProblem, ok, replaceTerm } from './ops';
import { S, ShapesIndex, shapesIndexOf } from './shapes-read';
import { isSkolem } from './skolem';
import { rdf } from './terms';

/** `base`, else `base-2`, `base-3`, …: the first that `used` does not have (added to `used`). */
function freeIri(base: string, used: UsedIris): string {
    let iri = base;
    for (let i = 2; used.has(iri); i++) iri = `${base}-${i}`;
    used.add(iri);
    return iri;
}

/** Local part for a name: the local name of an IRI, safe characters only. */
const nameOf = (iri: string) => localName(iri).replace(/[^A-Za-z0-9_.-]/g, '') || 'x';

/** The shapes index of the graph, cached (shapes-read.ts `shapesIndexOf`). Do not change it. */
export const shapesIndex = shapesIndexOf;

const integer = (v: number) => rdf.literal(String(Math.round(v)), rdf.namedNode(NS.xsd + 'integer'));
const TRUE = rdf.literal('true', rdf.namedNode(NS.xsd + 'boolean'));

/** A node shape of the shapes graphs: an IRI with sh:NodeShape, a mapped target, sh:property or a logical constraint, and no sh:path. */
export function nodeShapeTerm(g: ModelGraph, id: string): NamedNode | undefined {
    const t = elementTerm(id);
    if (t?.termType !== 'NamedNode') return undefined;
    const quads = g.match(t).filter(q => g.isShapesGraph(q.graph));
    if (quads.some(q => q.predicate.equals(S.path))) return undefined;
    return (quads.some(q => (q.predicate.equals(S.type) && q.object.equals(S.NodeShape)) || [S.targetClass, S.targetSubjectsOf, S.targetObjectsOf, S.targetNode, S.node, S.property, S.or, S.xone, S.and, S.not].some(p => p.equals(q.predicate)))
        || (quads.length > 0 && g.match(null, S.node, t).some(q => g.isShapesGraph(q.graph))))
        ? t : undefined;
}

// ------------------------------------------------------------------ RDF lists

export function readList(g: ModelGraph, head: Term, graph: Term): Quad_Object[] {
    const items: Quad_Object[] = [];
    for (let h: Term | undefined = head, i = 0; h && !h.equals(S.nil) && i < 10000; i++) {
        const item = g.object(h, S.first, graph);
        if (!item) break;
        items.push(item);
        h = g.object(h, S.rest, graph);
    }
    return items;
}

/** Remove the cells of a list (not its items). */
function removeListCells(g: ModelGraph, head: Term, graph: Term): void {
    for (let h: Term | undefined = head, i = 0; h && !h.equals(S.nil) && h.termType !== 'Literal' && i < 10000; i++) {
        const next = g.object(h, S.rest, graph);
        if (!g.object(h, S.first, graph)) break;
        g.removeMatches(h, S.first, null, graph);
        g.removeMatches(h, S.rest, null, graph);
        h = next;
    }
}

/** A free IRI `<base>` (or `<base>-2`, …) for a new node. */
export function newIri(g: ModelGraph, base: string): NamedNode {
    return rdf.namedNode(freeIri(base, g.usedIris()));
}

/** A list with IRI cells `<base>`, `<base>-2`, … Returns its head (rdf:nil when empty). */
function writeList(g: ModelGraph, items: Quad_Object[], graph: Quad_Graph, base: string): Quad_Object {
    const used = g.usedIris();
    const first = freeIri(base, used);
    const cells = items.map((_, i) => rdf.namedNode(i === 0 ? first : freeIri(`${first}-${i + 1}`, used)));
    items.forEach((item, i) => {
        g.add(cells[i], S.first, item, graph);
        g.add(cells[i], S.rest, cells[i + 1] ?? S.nil, graph);
    });
    return cells[0] ?? S.nil;
}

/** A node named after `owner` (`<owner>-…`), or a node that was a blank node in its file (skolem.ts): it belongs to the owner. */
const ownedBy = (t: Term, owner: Term) => isSkolem(t) || (t.termType === 'NamedNode' && t.value.startsWith(owner.value + '-'));

/** Remove a subject and the nodes that belong to it and that nothing else uses (list cells, nested shapes, path expressions). */
export function removeOwned(g: ModelGraph, s: Term, graph: Term, owner: Term = s): void {
    const quads = [...g.match(s, null, null, graph)];
    for (const q of quads) g.remove(q);
    for (const q of quads) {
        if (ownedBy(q.object, owner) && !q.object.equals(S.nil) && g.match(null, null, q.object).length === 0) removeOwned(g, q.object, graph, owner);
    }
}

/** Remove the values of a predicate, with the nodes that belong to the subject (list cells, path expressions). */
function clear(g: ModelGraph, s: Quad_Subject, p: NamedNode, graph: Quad_Graph): void {
    for (const q of [...g.match(s, p, null, graph)]) {
        g.remove(q);
        if (ownedBy(q.object, s) && !q.object.equals(S.nil) && g.match(null, null, q.object).length === 0) removeOwned(g, q.object, graph, s);
    }
}

// ------------------------------------------------------------------ paths and ranges

/** The editor writes simple paths (one IRI). */
const SIMPLE_PATHS = 'The editor writes simple paths only (one predicate, prefix:local or <iri>).';

/** The shape that checks "a concept in scheme X": `<scheme shape> sh:property <scheme shape>-inScheme`. Created when missing. */
function schemeShape(g: ModelGraph, idx: ShapesIndex, scheme: string, graph: Quad_Graph): NamedNode {
    const found = idx.schemeShape.get(scheme);
    if (found) return found;
    const label = idx.model.valueSets[elementId(rdf.namedNode(scheme))]?.label ?? nameOf(scheme);
    const shape = newIri(g, mint(`${label} concept`));
    const ps = rdf.namedNode(shape.value + '-inScheme');
    g.add(shape, S.type, S.NodeShape, graph);
    g.add(shape, S.property, ps, graph);
    g.add(ps, S.type, S.PropertyShape, graph);
    g.add(ps, S.path, S.inScheme, graph);
    g.add(ps, S.hasValue, rdf.namedNode(scheme), graph);
    return shape;
}

/** The shape that checks "a member of collection C": `dct:source C`, sh:in the members. Created when missing. */
function memberShape(g: ModelGraph, idx: ShapesIndex, collection: string, graph: Quad_Graph): NamedNode {
    const found = idx.memberShapes.get(collection)?.[0];
    if (found) return found;
    const set = idx.model.valueSets[elementId(rdf.namedNode(collection))];
    const shape = newIri(g, mint(`${set?.label ?? nameOf(collection)} member`));
    g.add(shape, S.type, S.NodeShape, graph);
    g.add(shape, S.source, rdf.namedNode(collection), graph);
    g.add(shape, S.in, writeList(g, (set?.members ?? []).map(m => rdf.namedNode(m.uri)), graph, shape.value + '-in'), graph);
    return shape;
}

/** Remove a scheme shape or member shape that no property uses any more. */
function dropUnusedHelper(g: ModelGraph, idx: ShapesIndex, node: Term | undefined, graph: Quad_Graph): void {
    if (!node || node.termType !== 'NamedNode' || g.match(null, S.node, node).length) return;
    const helper = [...idx.schemeShape.values(), ...[...idx.memberShapes.values()].flat()].some(h => h.equals(node));
    if (helper) removeOwned(g, node, graph);
}

/** Replace the range statements (sh:datatype, sh:nodeKind, sh:class, sh:node, sh:in, sh:or) of a property shape. */
function writeRange(g: ModelGraph, idx: ShapesIndex, ps: Quad_Subject, range: Range, graph: Quad_Graph): Result {
    // sh:node of the property shape and of the members of its sh:or: helper shapes that can become unused.
    const oldNodes = [ps, ...g.match(ps, S.or, null, graph).flatMap(q => readList(g, q.object, graph))].map(t => g.object(t, S.node, graph));
    for (const p of [S.datatype, S.nodeKind, S.class, S.node, S.in, S.or]) clear(g, ps, p, graph);
    for (const node of oldNodes) dropUnusedHelper(g, idx, node, graph);
    const r = range.kind === 'or' ? orRange(range.alternatives) : range;
    if (r.kind !== 'or') return writeSimpleRange(g, idx, ps, r, graph);
    // One member shape for each alternative, named after the property shape and the alternative (`<ps>-DatasetSeries`).
    const members: NamedNode[] = [];
    for (const a of r.alternatives) {
        const m = newIri(g, `${ps.value}-${alternativeName(idx, a)}`);
        const w = writeSimpleRange(g, idx, m, a, graph);
        if (!w.ok) return w;
        members.push(m);
    }
    g.add(ps, S.or, writeList(g, members, graph, `${ps.value}-or`), graph);
    return ok(undefined);
}

/** Name part of the member shape of an alternative. */
function alternativeName(idx: ShapesIndex, a: Range): string {
    switch (a.kind) {
        case 'node': return nameOf(idx.nodeShape.get(a.shape)?.term.value ?? 'shape');
        case 'class': return nameOf(a.class);
        case 'datatype': return nameOf(a.datatype);
        case 'nodeKind': return a.nodeKind;
        case 'scheme': return nameOf(a.schemes[0] ?? 'scheme');
        case 'collection': return nameOf(a.collection);
        default: return 'alternative';
    }
}

function writeSimpleRange(g: ModelGraph, idx: ShapesIndex, ps: Quad_Subject, range: Range, graph: Quad_Graph): Result {
    switch (range.kind) {
        case 'node': {
            const target = idx.nodeShape.get(range.shape);
            if (!target) return gone('node shape', range.shape);
            g.add(ps, S.node, target.term, graph);
            break;
        }
        case 'class': g.add(ps, S.class, rdf.namedNode(range.class), graph); break;
        case 'datatype': g.add(ps, S.datatype, rdf.namedNode(range.datatype), graph); break;
        case 'nodeKind': g.add(ps, S.nodeKind, rdf.namedNode(NS.sh + range.nodeKind), graph); break;
        case 'in': return fail('A set of values is a SKOS concept scheme or collection: pick one as the target.');
        case 'scheme': {
            if (range.schemes.length !== 1) return fail('Pick one concept scheme.');
            g.add(ps, S.nodeKind, rdf.namedNode(NS.sh + 'IRI'), graph);
            g.add(ps, S.node, schemeShape(g, idx, range.schemes[0], graph), graph);
            break;
        }
        case 'collection': {
            if (!idx.model.valueSets[elementId(rdf.namedNode(range.collection))]) return gone('collection', range.collection);
            g.add(ps, S.nodeKind, rdf.namedNode(NS.sh + 'IRI'), graph);
            g.add(ps, S.node, memberShape(g, idx, range.collection, graph), graph);
            break;
        }
        case 'or': return fail('An alternative cannot be "one of" again.');
        case 'any': break;
    }
    return ok(undefined);
}

// ------------------------------------------------------------------ data migrations

/** Statements of the model graph that a migration changes now. */
export function migrationCount(g: ModelGraph, m: MigrationChange): number {
    if (m.kind === 'renameClass') return g.match(null, P.type, rdf.namedNode(m.from), g.model).length;
    const from = rdf.namedNode(m.from);
    const quads = g.match(null, from, null, g.model);
    if (!m.classIri) return quads.length;
    const cls = rdf.namedNode(m.classIri);
    return quads.filter(q => g.has(rdf.quad(q.subject, P.type, cls, g.model))).length;
}

/** Apply a migration to the data. Edge layouts of renamed relations follow in every view. */
export function migrate(g: ModelGraph, m: MigrationChange): Result<number> {
    const count = migrationCount(g, m);
    if (count === 0) return fail('The data has no statements that this change applies to.');
    if (m.kind === 'renameClass') {
        for (const q of [...g.match(null, P.type, rdf.namedNode(m.from), g.model)]) {
            g.remove(q);
            g.add(q.subject, P.type, rdf.namedNode(m.to));
        }
        return ok(count);
    }
    const from = rdf.namedNode(m.from), to = rdf.namedNode(m.to);
    const cls = m.classIri ? rdf.namedNode(m.classIri) : undefined;
    for (const q of [...g.match(null, from, null, g.model)]) {
        if (cls && !g.has(rdf.quad(q.subject, P.type, cls, g.model))) continue;
        g.remove(q);
        g.add(q.subject, to, q.object);
        for (const view of g.views()) {
            const e = g.edgeOf(view, q.subject, from, q.object);
            if (e) g.set(e, P.reifies, rdf.quad(q.subject, to, q.object), view);
        }
    }
    return ok(count);
}

/**
 * An IRI change of a class, predicate or shape (a rename): every statement with `from` changes, in the shapes graphs, the model graph
 * (vocabulary: rdfs:subClassOf, rdfs:domain, labels, …) and the views; each one stays in its file. Not the data that uses `from`:
 * `?x rdf:type from` and the statements with `from` as predicate, with their placements (the triple terms that they reify). A migration proposes these.
 */
function renameIri(g: ModelGraph, from: NamedNode, to: NamedNode): void {
    replaceTerm(g, from, to, q => g.isDataGraph(q.graph) && q.predicate.equals(P.type) && q.object.equals(from));
}

/** `t` occurs in no statement other than `self`. */
function onlyIn(g: ModelGraph, t: NamedNode, self: Quad): boolean {
    return [...g.match(t), ...g.match(null, t), ...g.match(null, null, t), ...g.match(null, null, null, t)].every(q => q.equals(self));
}

/**
 * A target class change (`set`: the new sh:targetClass statement) renames the class when no other node shape targets the old class
 * (sh:targetClass, or the shape IRI as an implicit class target) and the new IRI is new. Else only this node shape changes.
 */
function isClassRename(g: ModelGraph, old: NamedNode, set: Quad): boolean {
    if (g.match(null, S.targetClass, old).some(q => g.isShapesGraph(q.graph))) return false;
    if (nodeShapeTerm(g, elementId(old))) return false;
    return onlyIn(g, set.object as NamedNode, set);
}

function propose(g: ModelGraph, change: MigrationChange, reason: string): void {
    if (migrationCount(g, change) > 0) g.proposed.push({ change, reason });
}

/** A migration with its current count, for the snapshot. */
export function withCount(g: ModelGraph, m: Omit<Migration, 'count'>): Migration {
    return { ...m, count: migrationCount(g, m) };
}

// ------------------------------------------------------------------ node shapes

/**
 * The IRI of a new node shape: the label + " shape" (not the IRI of its class), without a second " shape". `used`: IRIs in use
 * (default: g.usedIris()); the new IRI joins it, so that several new shapes get different IRIs.
 */
export function mintShapeIri(g: ModelGraph, label: string, used = g.usedIris()): string {
    const base = /\sshape$/i.test(label.trim()) ? label.trim() : `${label} shape`;
    let iri = mint(base);
    for (let i = 2; used.has(iri); i++) iri = mint(`${base} ${i}`);
    used.add(iri);
    return iri;
}

export function createNodeShape(g: ModelGraph, label: string, targetClass?: string): Result<string> {
    const problem = labelProblem(label);
    if (problem) return fail(problem);
    const graph = g.shapesTarget();
    if (!graph) return fail('The workspace has no shapes file. Use "Add Shapes…" first: new shapes go to the primary shapes file.');
    const s = rdf.namedNode(mintShapeIri(g, label));
    g.add(s, S.type, S.NodeShape, graph);
    g.add(s, S.name, rdf.literal(label), graph);
    if (targetClass) g.add(s, S.targetClass, rdf.namedNode(targetClass), graph);
    return ok(elementId(s));
}


export function setNodeShape(g: ModelGraph, id: string, patch: NodeShapePatch): Result {
    const shape = shapesIndex(g).nodeShape.get(id);
    if (!shape) return gone('node shape', id);
    const { term: s, graph } = shape;
    if (patch.targetClass !== undefined) {
        const old = g.object(s, S.targetClass, graph)?.value;
        const next = patch.targetClass.trim();
        g.set(s, S.targetClass, next ? rdf.namedNode(next) : undefined, graph);
        if (old && next && old !== next && isClassRename(g, rdf.namedNode(old), rdf.quad(s, S.targetClass, rdf.namedNode(next), graph))) {
            renameIri(g, rdf.namedNode(old), rdf.namedNode(next));
        }
        if (old && next && old !== next) propose(g, { kind: 'renameClass', from: old, to: next }, `Target class of "${g.object(s, S.name, graph)?.value ?? shortIri(s.value)}": ${shortIri(old)} → ${shortIri(next)}`);
    }
    for (const [values, predicate] of [[patch.targetSubjectsOf, S.targetSubjectsOf], [patch.targetObjectsOf, S.targetObjectsOf], [patch.nodes, S.node]] as const) {
        if (values === undefined) continue;
        const next = new Set(values.map(iri => iri.trim()).filter(Boolean));
        const existing = g.match(s, predicate).filter(q => g.isShapesGraph(q.graph));
        for (const q of existing) if (!next.has(q.object.value)) g.remove(q);
        const retained = new Set(existing.map(q => q.object.value));
        for (const iri of next) if (!retained.has(iri)) g.add(s, predicate, rdf.namedNode(iri), graph);
    }
    if (patch.closed !== undefined) {
        g.set(s, S.closed, patch.closed ? TRUE : undefined, graph);
        // rdf:type is on every instance: a closed shape ignores it.
        if (patch.closed && !g.object(s, S.ignoredProperties, graph)) g.add(s, S.ignoredProperties, writeList(g, [P.type], graph, s.value + '-ignoredProperties'), graph);
    }
    if (patch.description !== undefined) g.set(s, S.description, patch.description.trim() ? rdf.literal(patch.description.trim()) : undefined, graph);
    return ok(undefined);
}

/** Delete a node shape: its statements, its property shapes, sh:node references to it, and its cards in all views. */
export function deleteNodeShape(g: ModelGraph, id: string): void {
    const shape = shapesIndex(g).nodeShape.get(id);
    if (!shape) return;
    removeOwned(g, shape.term, shape.graph);
    for (const q of g.match(null, S.node, shape.term)) g.remove(q);
    for (const view of g.views()) dropFromView(g, view, shape.term);
}

// ------------------------------------------------------------------ property shapes

export interface PropertyShapeInput {
    path: PathJSON;
    range: Range;
    minCount?: number;
    maxCount?: number;
    name?: string;
}

/** Id of the property shape `term` of `owner` after a change (ids derive from path and range). */
function idOf(g: ModelGraph, owner: NamedNode, term: Term): string | undefined {
    for (const [id, p] of shapesIndex(g).property) if (p.owner.equals(owner) && p.term.equals(term)) return id;
    return undefined;
}

function countsProblem(min?: number | null, max?: number | null): string | undefined {
    for (const v of [min, max]) if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 0)) return 'A cardinality is a whole number, 0 or more.';
    if (typeof min === 'number' && typeof max === 'number' && max < min) return 'The maximum is less than the minimum.';
    return undefined;
}

export function createPropertyShape(g: ModelGraph, shapeId: string, input: PropertyShapeInput): Result<string> {
    const idx = shapesIndex(g);
    const shape = idx.nodeShape.get(shapeId);
    if (!shape) return gone('node shape', shapeId);
    const problem = countsProblem(input.minCount, input.maxCount);
    if (problem) return fail(problem);
    if (input.path.kind !== 'iri') return fail(SIMPLE_PATHS);
    const { term: s, graph } = shape;
    const ps = newIri(g, `${s.value}-${nameOf(input.path.iri)}`);
    g.add(s, S.property, ps, graph);
    g.add(ps, S.type, S.PropertyShape, graph);
    g.add(ps, S.path, rdf.namedNode(input.path.iri), graph);
    const r = writeRange(g, idx, ps, input.range, graph);
    if (!r.ok) return r;
    if (input.minCount) g.add(ps, S.minCount, integer(input.minCount), graph);
    if (input.maxCount !== undefined) g.add(ps, S.maxCount, integer(input.maxCount), graph);
    if (input.name?.trim()) g.add(ps, S.name, rdf.literal(input.name.trim()), graph);
    return ok(idOf(g, s, ps)!);
}


/** Change a property shape. Returns its new id (the id follows path and range). */
export function setPropertyShape(g: ModelGraph, id: string, patch: PropertyShapePatch): Result<string> {
    const idx = shapesIndex(g);
    const p = idx.property.get(id);
    const before = idx.model.properties[id];
    if (!p || !before) return gone('property shape', id);
    const { term: ps, graph, owner } = p;
    const min = 'minCount' in patch ? patch.minCount : before.minCount, max = 'maxCount' in patch ? patch.maxCount : before.maxCount;
    const problem = countsProblem(min, max);
    if (problem) return fail(problem);
    if (patch.path) {
        if (patch.path.kind !== 'iri') return fail(SIMPLE_PATHS);
        clear(g, ps, S.path, graph);
        g.add(ps, S.path, rdf.namedNode(patch.path.iri), graph);
        if (before.path.kind === 'iri' && patch.path.kind === 'iri' && before.path.iri !== patch.path.iri) {
            const from = rdf.namedNode(before.path.iri), to = rdf.namedNode(patch.path.iri);
            // A rename when no other property shape has the old path and the new IRI is new; else only this property shape changes.
            if (!g.match(null, S.path, from).some(q => g.isShapesGraph(q.graph)) && onlyIn(g, to, rdf.quad(ps, S.path, to, graph))) renameIri(g, from, to);
            const shape = idx.model.nodeShapes[before.owner];
            propose(g, { kind: 'renamePredicate', classIri: shape.targetClass, from: before.path.iri, to: patch.path.iri },
                `Path of ${shape.label}: ${formatPath(before.path)} → ${formatPath(patch.path)}`);
        }
    }
    if (patch.range) {
        const r = writeRange(g, idx, ps, patch.range, graph);
        if (!r.ok) return r;
    }
    const num = (pred: NamedNode, v: number | null | undefined) => g.set(ps, pred, typeof v === 'number' ? integer(v) : undefined, graph);
    const text = (pred: NamedNode, v: string | null | undefined) => g.set(ps, pred, v?.trim() ? rdf.literal(v.trim()) : undefined, graph);
    if ('minCount' in patch) num(S.minCount, patch.minCount || null);
    if ('maxCount' in patch) num(S.maxCount, patch.maxCount);
    if ('minLength' in patch) num(S.minLength, patch.minLength);
    if ('maxLength' in patch) num(S.maxLength, patch.maxLength);
    if ('name' in patch) text(S.name, patch.name);
    if ('description' in patch) text(S.description, patch.description);
    if ('pattern' in patch) text(S.pattern, patch.pattern);
    if ('languageIn' in patch) {
        clear(g, ps, S.languageIn, graph);
        const tags = (patch.languageIn ?? []).map(t => t.trim()).filter(Boolean);
        if (tags.length) g.add(ps, S.languageIn, writeList(g, tags.map(t => rdf.literal(t)), graph, ps.value + '-languageIn'), graph);
    }
    const next = idOf(g, owner, ps);
    return next ? ok(next) : fail('The property shape has no path any more.');
}

/** Take a member out of its list; a list of or/xone/and with one member left is dissolved (its member goes back to sh:property). */
function takeOutOfList(g: ModelGraph, owner: NamedNode, graph: NamedNode, operator: LogicalOperator, head: Quad_Object, member: Term): void {
    const items = readList(g, head, graph).filter(x => !x.equals(member));
    g.remove(rdf.quad(owner, S[operator as 'or'], head, graph));
    removeListCells(g, head, graph);
    if (items.length <= 1) {
        for (const x of items) g.add(owner, S.property, x, graph);
        return;
    }
    g.add(owner, S[operator as 'or'], writeList(g, items, graph, `${owner.value}-${operator}`), graph);
}

/** Delete property shapes: from sh:property or their logical constraint, with their statements when nothing else uses them. */
export function deletePropertyShape(g: ModelGraph, id: string): void {
    const p = shapesIndex(g).property.get(id);
    if (!p) return;
    const { term, owner, graph, placement } = p;
    if (placement.via === 'property') g.remove(rdf.quad(owner, S.property, term, graph));
    else if (placement.via === 'not') g.remove(rdf.quad(owner, S.not, term, graph));
    else takeOutOfList(g, owner, graph, placement.operator, placement.head, term);
    if (g.match(null, null, term).length === 0) {
        const nodes = [term, ...g.match(term, S.or, null, graph).flatMap(q => readList(g, q.object, graph))].map(t => g.object(t, S.node, graph));
        removeOwned(g, term, graph);
        const after = shapesIndex(g);
        for (const node of nodes) dropUnusedHelper(g, after, node, graph);
    }
}

// ------------------------------------------------------------------ logical constraints

/**
 * Group property shapes of one node shape into a logical constraint: `ids` are property shapes, or one constraint and property
 * shapes (they join it). The members leave sh:property; a member without sh:minCount gets 1, so that "a or b" asks for one of them.
 * Returns the id of the constraint.
 */
export function groupProperties(g: ModelGraph, ids: string[], operator: Exclude<LogicalOperator, 'not'> = 'or'): Result<string> {
    const idx = shapesIndex(g);
    const joining = ids.map(id => idx.constraint.get(id) ? id : idx.model.properties[id]?.constraint).filter((x): x is string => !!x);
    const distinct = [...new Set(joining)];
    if (distinct.length > 1) return fail('The edges are in different logical constraints. Ungroup one of them first.');
    const props = ids.filter(id => idx.property.has(id) && !idx.model.properties[id].constraint);
    const existing = distinct[0] ? idx.constraint.get(distinct[0]) : undefined;
    if (existing?.operator === 'not') return fail('A "not" constraint has one member.');
    const owners = new Set([...props.map(id => idx.property.get(id)!.owner.value), ...(existing ? [existing.owner.value] : [])]);
    if (owners.size > 1) return fail('A logical constraint groups edges of one node shape. These edges start at different shapes.');
    if (!existing && props.length < 2) return fail('Select two or more edges of one node shape.');
    if (existing && props.length === 0) return fail('These edges are already in this constraint.');
    const first = idx.property.get(props[0]) ?? existing!;
    const owner = first.owner, graph = first.graph;
    const terms = props.map(id => idx.property.get(id)!.term);
    for (const t of terms) {
        g.remove(rdf.quad(owner, S.property, t, graph));
        if (!g.object(t, S.minCount, graph)) g.add(t as Quad_Subject, S.minCount, integer(1), graph);
    }
    let op: LogicalOperator = operator;
    if (existing) {
        op = existing.operator;
        const items = [...readList(g, existing.head, graph), ...terms];
        g.remove(rdf.quad(owner, S[op as 'or'], existing.head, graph));
        removeListCells(g, existing.head, graph);
        g.add(owner, S[op as 'or'], writeList(g, items, graph, `${owner.value}-${op}`), graph);
    } else {
        g.add(owner, S[op as 'or'], writeList(g, terms, graph, `${owner.value}-${op}`), graph);
    }
    const after = shapesIndex(g);
    const cid = after.model.properties[idOf(g, owner, terms[0])!]?.constraint;
    return cid ? ok(cid) : fail('The constraint was not created.');
}

/** Change the operator of a constraint. "not" needs one member; from "not", the member becomes a list of one. */
export function setConstraintOperator(g: ModelGraph, id: string, operator: LogicalOperator): Result<string> {
    const idx = shapesIndex(g);
    const c = idx.constraint.get(id);
    const model = idx.model.constraints[id];
    if (!c || !model) return gone('logical constraint', id);
    if (c.operator === operator) return ok(id);
    const { owner, graph, head } = c;
    const members = c.operator === 'not' ? [head] : readList(g, head, graph);
    if (operator === 'not' && members.length !== 1) return fail('"not" takes one member. Remove members first, or use "or", "xone" or "and".');
    g.remove(rdf.quad(owner, S[c.operator as 'or'], head, graph));
    if (c.operator !== 'not') removeListCells(g, head, graph);
    g.add(owner, S[operator as 'or'], operator === 'not' ? members[0] : writeList(g, members, graph, `${owner.value}-${operator}`), graph);
    const after = shapesIndex(g);
    const cid = model.members.length ? after.model.properties[idOf(g, owner, members[0])!]?.constraint : undefined;
    return cid ? ok(cid) : fail('The constraint was not found after the change.');
}

/** Dissolve a constraint: its members go back to sh:property of the node shape. */
export function ungroup(g: ModelGraph, id: string): Result<string[]> {
    const idx = shapesIndex(g);
    const c = idx.constraint.get(id);
    if (!c) return gone('logical constraint', id);
    const { owner, graph, head, operator } = c;
    const members = operator === 'not' ? [head] : readList(g, head, graph);
    g.remove(rdf.quad(owner, S[operator as 'or'], head, graph));
    if (operator !== 'not') removeListCells(g, head, graph);
    for (const m of members) g.add(owner, S.property, m, graph);
    return ok(members.map(m => idOf(g, owner, m)).filter((x): x is string => !!x));
}

/** Take one property shape out of its constraint (back to sh:property). */
export function takeOutOfConstraint(g: ModelGraph, propertyId: string): Result {
    const p = shapesIndex(g).property.get(propertyId);
    if (!p) return gone('property shape', propertyId);
    if (p.placement.via === 'property') return ok(undefined);
    if (p.placement.via === 'not') g.remove(rdf.quad(p.owner, S.not, p.term, p.graph));
    else {
        takeOutOfList(g, p.owner, p.graph, p.placement.operator, p.placement.head, p.term);
        if (g.has(rdf.quad(p.owner, S.property, p.term, p.graph))) return ok(undefined);
    }
    g.add(p.owner, S.property, p.term, p.graph);
    return ok(undefined);
}

/** Delete shapes elements: node shapes, property shapes; a constraint is dissolved (its members stay). */
export function deleteShapes(g: ModelGraph, ids: string[]): Result {
    const idx = shapesIndex(g);
    const shapes = ids.filter(id => idx.nodeShape.has(id));
    // Property shapes and constraints of deleted node shapes go with them.
    const gone = new Set(shapes);
    const properties = ids.filter(id => idx.property.has(id) && !gone.has(idx.model.properties[id].owner));
    const constraints = ids.filter(id => idx.constraint.has(id) && !gone.has(idx.model.constraints[id].owner));
    if (!shapes.length && !properties.length && !constraints.length) return fail('Nothing to delete: select node shapes, edges or logical constraints.');
    // Resolve by term: the ids change while the property shapes are removed.
    const terms = properties.map(id => ({ term: idx.property.get(id)!.term, owner: idx.property.get(id)!.owner }));
    for (const c of constraints) { const r = ungroup(g, c); if (!r.ok) return r; }
    for (const t of terms) { const id = idOf(g, t.owner, t.term); if (id) deletePropertyShape(g, id); }
    for (const s of shapes) deleteNodeShape(g, s);
    return ok(undefined);
}

/**
 * Set the IRI of a shapes element (node shape, value set, IRI property shape). Empty (undefined or '') mints one: from the name
 * (node shape, value set) or from the owner and the path (property shape). The IRI changes everywhere (renameIri) except in the
 * rdf:type statements of the data: when instances have the old IRI as rdf:type (implicit class target), a migration is proposed.
 * Returns the new element id (ids follow the IRI, see ids.ts).
 */
export function setShapeUri(g: ModelGraph, id: string, uri: string | undefined): Result<string> {
    const el = shapesCardTerm(g, id);
    if (!el) return gone('element', id);
    const idx = shapesIndex(g);
    const property = idx.model.properties[id];
    let value = uri?.trim();
    if (!value && property) {
        if (property.path.kind !== 'iri') return fail('A property shape with a complex path gets no minted IRI. Enter an IRI.');
        value = newIri(g, `${idx.property.get(id)!.owner.value}-${nameOf(property.path.iri)}`).value;
    }
    if (!value) value = idx.model.nodeShapes[id] ? mintShapeIri(g, idx.model.nodeShapes[id].label) : newIri(g, mint(idx.model.valueSets[id]?.label ?? 'value set')).value;
    if (value === el.value) return ok(id);
    const problem = iriProblem(g, value, el);
    if (problem) return fail(problem);
    const to = rdf.namedNode(value);
    renameIri(g, el, to);
    propose(g, { kind: 'renameClass', from: el.value, to: value }, `IRI of "${shortIri(el.value)}" → ${shortIri(value)}: the data uses the old IRI as a class`);
    return ok(property ? idOf(g, idx.property.get(id)!.owner, to) ?? elementId(to) : elementId(to));
}

// ------------------------------------------------------------------ value sets (SKOS concept schemes and collections)

/** A card of a shapes view: a node shape, a value set, or a property shape drawn out of its card (IRI property shapes only). */
export function shapesCardTerm(g: ModelGraph, id: string): NamedNode | undefined {
    const node = nodeShapeTerm(g, id);
    if (node) return node;
    const idx = shapesIndex(g);
    const set = idx.valueSet.get(id);
    if (set) return set.term;
    return idx.property.get(id)?.term as NamedNode | undefined;
}

/** New concept scheme or collection in the data file (the model graph): its concepts are data that instances refer to. */
export function createValueSet(g: ModelGraph, kind: 'scheme' | 'collection', label: string): Result<string> {
    const problem = labelProblem(label);
    if (problem) return fail(problem);
    const graph = g.model;
    const s = newIri(g, mint(label));
    g.add(s, S.type, kind === 'scheme' ? S.ConceptScheme : S.Collection, graph);
    g.add(s, S.prefLabel, rdf.literal(label), graph);
    return ok(elementId(s));
}

/** The sh:in lists of the member shapes of a collection follow its members. */
function syncMembers(g: ModelGraph, collection: NamedNode): void {
    const idx = shapesIndex(g);
    const set = idx.model.valueSets[elementId(collection)];
    for (const shape of idx.memberShapes.get(collection.value) ?? []) {
        const graph = g.match(shape, S.source, collection)[0]?.graph as NamedNode;
        clear(g, shape, S.in, graph);
        g.add(shape, S.in, writeList(g, (set?.members ?? []).map(m => rdf.namedNode(m.uri)), graph, shape.value + '-in'), graph);
    }
}

/** A new concept `label` in a scheme (skos:inScheme), or in a collection (skos:member); or an existing concept (`uri`) joins it. */
export function addConcept(g: ModelGraph, setId: string, input: { label?: string; uri?: string }): Result<string> {
    const set = shapesIndex(g).valueSet.get(setId);
    if (!set) return gone('concept scheme or collection', setId);
    const { term, graph } = set;
    const isScheme = g.has(rdf.quad(term, S.type, S.ConceptScheme, graph));
    let concept: NamedNode;
    if (input.uri) concept = rdf.namedNode(input.uri);
    else {
        const label = input.label?.trim() ?? '';
        const problem = labelProblem(label);
        if (problem) return fail(problem);
        concept = newIri(g, mint(label));
        g.add(concept, S.type, S.Concept, graph);
        g.add(concept, S.prefLabel, rdf.literal(label), graph);
    }
    if (isScheme) g.add(concept, S.inScheme, term, graph);
    else {
        if (g.has(rdf.quad(term, S.member, concept, graph))) return fail('The concept is already a member.');
        g.add(term, S.member, concept, graph);
        syncMembers(g, term);
    }
    return ok(concept.value);
}

/** Add a broader concept in the child's shapes file. Keep other parents; include inverse skos:narrower when checking cycles. */
export function setConceptBroader(g: ModelGraph, uri: string, broader: string): Result {
    const idx = shapesIndex(g);
    const parents = new Map<string, Set<string>>();
    const add = (child: string, parent: string) => {
        if (!parents.has(child)) parents.set(child, new Set());
        parents.get(child)!.add(parent);
    };
    for (const q of g.shapesAndVocabulary()) {
        if (q.predicate.equals(S.broader)) add(q.subject.value, q.object.value);
        if (q.predicate.equals(S.narrower)) add(q.object.value, q.subject.value);
    }
    const problem = broaderProblem(uri, broader, u => isValueSetMember(idx.model, u), u => parents.get(u) ?? []);
    if (problem) return fail(problem);
    if (parents.get(uri)?.has(broader)) return ok(undefined);
    const child = rdf.namedNode(uri);
    const graph = g.shapesAndVocabulary().find(q => q.subject.equals(child))?.graph
        ?? idx.valueSet.get(Object.values(idx.model.valueSets).find(v => v.members.some(m => m.uri === uri))!.id)!.graph;
    g.add(child, S.broader, rdf.namedNode(broader), graph);
    return ok(undefined);
}

/** Take a concept out of a value set. In a scheme the concept is deleted (its statements, and the statements that refer to it); in a collection it stays. */
export function removeConcept(g: ModelGraph, setId: string, uri: string): Result {
    const set = shapesIndex(g).valueSet.get(setId);
    if (!set) return gone('concept scheme or collection', setId);
    const c = rdf.namedNode(uri);
    if (g.has(rdf.quad(set.term, S.type, S.ConceptScheme, set.graph))) {
        const others = g.match(c, S.inScheme).filter(q => !q.object.equals(set.term));
        if (others.length) g.removeMatches(c, S.inScheme, set.term);
        else {
            const touched = rdf.termSet<NamedNode>();
            // Its statements and the statements that refer to it, also in the data (an instance that has this concept as a value).
            const refs = [...g.shapesQuads(), ...g.match(null, null, null, g.model)].filter(q => q.subject.equals(c) || q.object.equals(c));
            for (const q of refs) {
                if (q.subject.termType === 'NamedNode' && !q.subject.equals(c)) touched.add(q.subject);
                g.remove(q);
            }
            for (const t of touched) if (g.match(t, S.type, S.Collection).length) syncMembers(g, t);
        }
        g.removeMatches(set.term, S.hasTopConcept, c);
        return ok(undefined);
    }
    g.removeMatches(set.term, S.member, c, set.graph);
    syncMembers(g, set.term);
    return ok(undefined);
}

/** Delete a value set that no property uses: its statements, and the concepts of a scheme that are in no other scheme. */
export function deleteValueSet(g: ModelGraph, id: string): Result {
    const idx = shapesIndex(g);
    const set = idx.valueSet.get(id);
    if (!set) return gone('concept scheme or collection', id);
    const users = Object.values(idx.model.properties).filter(p => alternativesOf(p.range).some(r => (r.kind === 'scheme' && r.schemes.includes(set.term.value))
        || (r.kind === 'collection' && r.collection === set.term.value)));
    if (users.length) return fail(`"${idx.model.valueSets[id].label}" is the target of ${users.length} propert${users.length === 1 ? 'y' : 'ies'}. Change or delete ${users.length === 1 ? 'it' : 'them'} first.`);
    if (idx.model.valueSets[id].kind === 'scheme') for (const m of idx.model.valueSets[id].members) removeConcept(g, id, m.uri);
    // The helper shapes are in a shapes file; the value set can be in the data file.
    for (const h of [idx.schemeShape.get(set.term.value), ...(idx.memberShapes.get(set.term.value) ?? [])]) {
        const graph = h && g.match(h)[0]?.graph;
        if (h && graph) removeOwned(g, h, graph);
    }
    removeOwned(g, set.term, set.graph);
    for (const q of [...g.shapesQuads(), ...g.match(null, null, null, g.model)].filter(q => q.object.equals(set.term))) g.remove(q);
    for (const view of g.views()) dropFromView(g, view, set.term);
    return ok(undefined);
}
