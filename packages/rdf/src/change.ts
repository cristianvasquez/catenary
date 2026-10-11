// The change pipeline (spec/manifest.hs §11.3 Change propagation): one module from a patch to its tier, its scope, the cache keys it
// invalidates, whether validation runs, and which canvases and panels it refreshes. ModelGraph, ModelStore, ViewState and the
// snapshot call these rules; no other file decides a scope.

import type { Quad, Term } from '@rdfjs/types';
import { ChangeReason, ChangeTier, Doc, NS, SnapshotChange } from '@catenary/model';
import { elementId } from './ids';

import { VALIDATION_GRAPH } from 'rdf-core';

/** The SHACL report of the last validation (rdf-core graph.ts). */
export { VALIDATION_GRAPH };
/** Placement geometry and style do not change figure derivation. */
export const LAYOUT_PREDICATES = new Set(['x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide'].map(p => NS.view + p));

/** The roles of the graphs and the quads that change the metamodel (ModelGraph). */
export interface GraphFacts {
    isDataGraph(t: Pick<Term, 'termType' | 'value'> | undefined): boolean;
    isShapesGraph(t: Term | undefined): boolean;
    isView(t: Term | undefined): boolean;
    /** A quad of a data graph that changes the metamodel: the SKOS vocabulary, an RDFS rule, or the text of a rule term. */
    metamodelQuad(q: Quad): boolean;
}

/** One change of a transaction (graph.ts Change). */
export interface QuadChange { op: 'add' | 'remove'; quad: Quad }

/** The cache inputs that a quad or a patch invalidates (ModelGraph.keys). */
export interface Dependencies { shapes: boolean; query: boolean; data: boolean; persisted: boolean }

/** What a quad is to the change pipeline. `other`: a graph without a role (not data, shapes, view or report). */
export type QuadKind = 'report' | 'shapes' | 'metamodel' | 'data' | 'layout' | 'view' | 'other';

export function quadKind(facts: GraphFacts, q: Quad): QuadKind {
    if (q.graph.value === VALIDATION_GRAPH) return 'report';
    if (facts.isShapesGraph(q.graph)) return 'shapes';
    if (facts.isDataGraph(q.graph)) return facts.metamodelQuad(q) ? 'metamodel' : 'data';
    if (!facts.isView(q.graph)) return 'other';
    return LAYOUT_PREDICATES.has(q.predicate.value) ? 'layout' : 'view';
}

/**
 * The cache inputs that one quad invalidates. A report changes none. A layout quad changes the persisted text only (keepsReads). A
 * view quad changes the data reads; the query reads only when it declares a view. A data quad changes both; a shapes or metamodel
 * quad also the shapes index.
 */
export function quadDependencies(facts: GraphFacts, q: Quad): Dependencies {
    const kind = quadKind(facts, q);
    const declaresView = q.predicate.value === NS.rdf + 'type' && q.object.value === NS.view + 'View';
    return {
        persisted: kind !== 'report',
        data: kind !== 'report' && kind !== 'layout',
        query: kind !== 'report' && kind !== 'layout' && (kind !== 'view' || declaresView),
        shapes: kind === 'shapes' || kind === 'metamodel'
    };
}

/** The scope of a change as the frontend and the canvases see it (ModelChange.scope, SnapshotChange). */
export interface ChangeScope {
    tier: ChangeTier;
    /** Views whose view graph changed. */
    views: string[];
    /** Instances in changed model statements, as subject or IRI object. */
    elements: string[];
    /** A shapes graph, the SKOS vocabulary or an RDFS rule changed. */
    shapes: boolean;
    /** Only the geometry or the style of placements changed (LAYOUT_PREDICATES of view graphs). */
    layout: boolean;
}

export interface Classified extends ChangeScope {
    /** Validation runs after this change (§9 validates). */
    validates: boolean;
    /** The cache inputs the patch invalidates (the union of quadDependencies). */
    invalidates: Dependencies;
}

/** The tier of a change (§11.3 tierOf). A load, a disk read, a file or shapes change, or a shapes flag: Rebuild. A layout-only edit: ViewPatch. Else: DataPatch. */
export function tierOf(c: Pick<SnapshotChange, 'reason' | 'shapes' | 'layout'>): ChangeTier {
    if (['load', 'files', 'disk', 'shapes'].includes(c.reason) || c.shapes) return 'rebuild';
    if (isEdit(c.reason) && c.layout) return 'view';
    return 'data';
}

const isEdit = (reason: ChangeReason) => reason === 'edit' || reason === 'undo' || reason === 'redo';

/**
 * Classify a committed patch (§11.3): the tier, the changed views and elements, the flags, whether validation runs, and the cache inputs
 * to invalidate. `openViews`: in the validation mode "views", a placement change on one of them validates too (§9 validationFocus).
 */
export function classify(graph: GraphFacts, patch: readonly QuadChange[], reason: ChangeReason, openViews: Iterable<string> = []): Classified {
    const facts = memoized(graph);
    const views = new Set<string>(), elements = new Set<string>();
    let shapes = false, layout = patch.length > 0;
    const invalidates: Dependencies = { shapes: false, query: false, data: false, persisted: false };
    for (const { quad: q } of patch) {
        const d = quadDependencies(facts, q);
        for (const k of Object.keys(invalidates) as (keyof Dependencies)[]) if (d[k]) invalidates[k] = true;
        const kind = quadKind(facts, q);
        if (kind !== 'layout') layout = false;
        if (kind === 'report') continue;
        if (kind === 'shapes') { shapes = true; continue; }
        if (kind === 'data' || kind === 'metamodel') {
            if (kind === 'metamodel') shapes = true;
            for (const t of [q.subject, q.object]) if (t.termType === 'NamedNode') elements.add(elementId(t));
            continue;
        }
        if (q.graph.termType === 'NamedNode') views.add(elementId(q.graph));
    }
    const scope = { views: [...views], elements: [...elements], shapes, layout };
    return { tier: tierOf({ reason, ...scope }), ...scope, validates: validates(scope, openViews), invalidates };
}

/**
 * Validation runs after a change of data statements (a changed element: the subject of a data statement is an IRI) or of the shapes,
 * not after a layout change (§9 validates). In the mode "views", a change of the placements of an open view starts a run too (what
 * the run checks changed, §9 validationFocus).
 */
export function validates(c: Pick<SnapshotChange, 'views' | 'elements' | 'shapes' | 'layout'>, openViews: Iterable<string> = []): boolean {
    if (c.layout) return false;
    const open = new Set(openViews);
    return (c.elements ?? []).length > 0 || !!c.shapes || (c.views ?? []).some(v => open.has(v));
}

/** A patch of placement geometry and style only (§11.3 ViewPatch): the kept reads stay. */
export function layoutOnly(graph: GraphFacts, patch: readonly QuadChange[]): boolean {
    const facts = memoized(graph);
    return patch.length > 0 && patch.every(c => quadKind(facts, c.quad) === 'layout');
}

/** The graph roles once per graph of a committed patch: `isView` reads the store. */
function memoized(facts: GraphFacts): GraphFacts {
    const views = new Map<string, boolean>();
    return {
        isDataGraph: t => facts.isDataGraph(t),
        isShapesGraph: t => facts.isShapesGraph(t),
        isView: t => { const k = t?.value ?? ''; let v = views.get(k); if (v === undefined) views.set(k, v = facts.isView(t)); return v; },
        metamodelQuad: q => facts.metamodelQuad(q)
    };
}

/** A ViewPatch and a save keep the reads that do not read the geometry: the figures, the explorer, the counts (§11.3 keepsReads). */
export function keepsReads(c: Pick<SnapshotChange, 'reason' | 'shapes' | 'layout'>): boolean {
    return c.reason === 'save' || tierOf(c) === 'view';
}

/**
 * The canvas of view `viewId` with the kept part `part` refreshes on this change (§11.3 refreshes). No scope: yes. A ViewPatch: only the
 * canvases of the changed views. Otherwise: a shapes change (shape cards, class names), a changed view the part holds (its own view, the
 * target of a reference), or a changed element the part holds (an instance, or a property shape whose count of violations changed).
 */
export function refreshes(part: Doc, viewId: string, c: SnapshotChange | undefined): boolean {
    if (!c) return true;
    if (tierOf(c) === 'view') return (c.views ?? []).includes(viewId);
    return !!c.shapes || (c.views ?? []).some(id => !!part.views[id]) || (c.elements ?? []).some(id => !!part.instances[id] || !!part.shapes.properties[id]);
}

/**
 * The DataPatch tier of a canvas (§11.3 keptDoc): the fresh records of `changed` (the instances of the part among the changed elements,
 * read with the scoped read and their neighbors) replace the records of the kept part. The relations of a changed instance are read
 * again; those with both ends in the part stay. The hidden edges of the view follow the relations (view-read.ts projectView: a relation
 * with both ends shown and no placement). Returns the relations that the part did not hold before: a placement of one of them in the
 * view needs a read of the view (the caller checks the store).
 */
export function mergeRecords(part: Doc, viewId: string, fresh: Doc, changed: readonly string[]): string[] {
    const view = part.views[viewId];
    const set = new Set(changed);
    for (const id of changed) part.instances[id] = fresh.instances[id];
    const touches = (r: { subject: string; object: string }) => set.has(r.subject) || set.has(r.object);
    const before = new Set(Object.keys(part.relations));
    for (const [id, r] of Object.entries(part.relations)) if (touches(r)) delete part.relations[id];
    for (const [id, r] of Object.entries(fresh.relations)) if (touches(r) && part.instances[r.subject] && part.instances[r.object]) part.relations[id] = r;
    if (!view) return [];
    // The edges of the view: the placed ones whose relation remains, then the hidden ones, ordered by their statement.
    const cards = new Set<string>(), collected = new Set<string>();
    for (const b of view.boxes) {
        if (b.kind === 'card') cards.add(b.element);
        else if (b.kind === 'collection') b.members.forEach(m => collected.add(m));
    }
    const shown = (id: string) => cards.has(id) || collected.has(id);
    const placed = view.edges.filter(e => e.id && part.relations[e.relation]);
    const placedRelations = new Set(placed.map(e => e.relation));
    const hidden = Object.values(part.relations)
        .filter(r => !placedRelations.has(r.id) && shown(r.subject) && shown(r.object))
        .map(r => collected.has(r.subject) || collected.has(r.object) ? { relation: r.id } : { relation: r.id, hidden: true });
    const statement = (relation: string) => { const r = part.relations[relation]; return [part.instances[r.subject].uri, r.predicate, part.instances[r.object].uri]; };
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    view.edges = [...placed, ...hidden].sort((a, b) => { const x = statement(a.relation), y = statement(b.relation); return cmp(x[0], y[0]) || cmp(x[1], y[1]) || cmp(x[2], y[2]); });
    return Object.keys(part.relations).filter(id => !before.has(id));
}
