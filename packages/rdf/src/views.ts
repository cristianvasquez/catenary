// The view vocabulary and the reads of view graphs: views, placements, connectors and marks. Functions of a ModelGraph.
// isView and views are graph rules: model-graph.ts passes them to ModelGraph. graph.ts does not import this module.

import { NS } from '@catenary/model';
import type { NamedNode, Quad, Quad_Graph, Quad_Object, Quad_Predicate, Quad_Subject, Term } from '@rdfjs/types';
import { createHash, randomBytes } from 'crypto';
import { ModelGraph, cmp, sorted } from './graph';
import { rdf, termKey } from './terms';
import { P } from './vocabulary';

/** The view vocabulary. */
export const V = {
    View: rdf.namedNode(NS.view + 'View'),
    Placement: rdf.namedNode(NS.view + 'Placement'),
    // Marks (spec/ui-manifest.hs §2.2): elements of the Project layer, kept by their placements. A mark holds its content; its
    // placements hold box and color. The statements of a mark are in the view file of the view where it was made.
    /** A label; what is inside is computed from the geometry of one view. */
    Frame: rdf.namedNode(NS.view + 'Frame'),
    /** Markdown text (`view:text`). */
    Note: rdf.namedNode(NS.view + 'Note'),
    /** A link to a file (ADR 0004): `view:file`, the path relative to the view file. */
    FileRef: rdf.namedNode(NS.view + 'FileRef'),
    file: rdf.namedNode(NS.view + 'file'),
    /** A group of entities (`view:member`). */
    EntityGroup: rdf.namedNode(NS.view + 'EntityGroup'),
    /** An arrow: the statement `x view:arrow y` (Project layer, visual only), kept by its placements. */
    arrow: rdf.namedNode(NS.view + 'arrow'),
    member: rdf.namedNode(NS.view + 'member'),
    element: rdf.namedNode(NS.view + 'element'),
    /** The view of a placement: `p view:element e ; view:view v` is a placement of e in v. */
    view: rdf.namedNode(NS.view + 'view'),
    text: rdf.namedNode(NS.view + 'text'),
    description: rdf.namedNode(NS.view + 'description'),
    x: rdf.namedNode(NS.view + 'x'),
    y: rdf.namedNode(NS.view + 'y'),
    width: rdf.namedNode(NS.view + 'width'),
    height: rdf.namedNode(NS.view + 'height'),
    color: rdf.namedNode(NS.view + 'color'),
    /** Content of a card: "simple" (class and name). Absent: detailed. */
    display: rdf.namedNode(NS.view + 'display'),
    fromSide: rdf.namedNode(NS.view + 'fromSide'),
    toSide: rdf.namedNode(NS.view + 'toSide'),
    /** On a box placement (true): the box leaves with its last line (ADR 0014, a box that a line or hub brought). */
    keptByLines: rdf.namedNode(NS.view + 'keptByLines')
};

/** View: a named graph (not the model graph) with a view:View subject. */
export function isView(g: ModelGraph, t: Term | undefined): boolean {
    return !!t && t.termType === 'NamedNode' && !t.equals(g.union) && g.match(null, P.type, V.View, t).length > 0;
}

/** View graph IRIs, sorted. */
export function views(g: ModelGraph): NamedNode[] {
    const seen = rdf.termSet<NamedNode>();
    for (const q of g.match(null, P.type, V.View)) if (isView(g, q.graph)) seen.add(q.graph as NamedNode);
    return sorted(seen);
}

/** The view:View subject of a view graph (normally the graph IRI). */
export function viewSubject(g: ModelGraph, view: Term): Quad_Subject | undefined {
    return g.subjects(P.type, V.View, view).sort((a, b) => cmp(a.value, b.value))[0];
}

/** The view:Placement of an instance in a view. */
export function nodeOf(g: ModelGraph, view: Term, instance: Term): Quad_Subject | undefined {
    return g.subjects(V.element, instance, view).find(s => g.store.has(rdf.quad(s, P.type, V.Placement, view as Quad_Graph)));
}

/** The placement of a connector (a relation, an arrow) in a view: the placement that reifies the triple `s p o`. */
export function edgeOf(g: ModelGraph, view: Term, s: Term, p: Term, o: Term): Quad_Subject | undefined {
    return g.subjects(P.reifies, rdf.quad(s as Quad_Subject, p as Quad_Predicate, o as Quad_Object), view)
        .find(e => g.store.has(rdf.quad(e, P.type, V.Placement, view as Quad_Graph)));
}

/** The triple of a placement of a connector in view graph `view` (the triple term that it reifies), or undefined. */
export function connectorOf(g: ModelGraph, placement: Term, view: Term): Quad | undefined {
    const t = g.match(placement, P.reifies, null, view).find(q => q.object.termType === 'Quad')?.object;
    return t as Quad | undefined;
}

/** The placements of connectors in view graph `view` (all views: undefined), with their triples. */
export function connectorPlacements(g: ModelGraph, view?: Term): { placement: Quad_Subject; triple: Quad; view: NamedNode }[] {
    return g.match(null, P.reifies, null, view ?? null)
        .filter(q => q.object.termType === 'Quad' && g.store.has(rdf.quad(q.subject, P.type, V.Placement, q.graph)))
        .map(q => ({ placement: q.subject, triple: q.object as Quad, view: q.graph as NamedNode }));
}

/** The placements of view graph `view` whose element has the type `type` (a mark), or is a view (`V.View`: view references). */
export function placementsOf(g: ModelGraph, view: Term, type: NamedNode): Quad_Subject[] {
    return g.subjects(P.type, V.Placement, view).filter(p => {
        const e = g.match(p, V.element, null, view)[0]?.object;
        if (!e || e.termType !== 'NamedNode') return false;
        return type.equals(V.View) ? isView(g, e) : g.match(e, P.type, type).length > 0;
    });
}

export function groups(g: ModelGraph, view: Term): Quad_Subject[] {
    return placementsOf(g, view, V.Frame);
}

export function notes(g: ModelGraph, view: Term): Quad_Subject[] {
    return placementsOf(g, view, V.Note);
}

/** The placements of arrows in view graph `view`. */
export function arrows(g: ModelGraph, view: Term): Quad_Subject[] {
    return connectorPlacements(g, view).filter(c => c.triple.predicate.equals(V.arrow)).map(c => c.placement);
}

/** A new mark IRI: `<view>/m/<id>`, `id` 6 random base-36 characters. */
export function markIri(g: ModelGraph, view: NamedNode): NamedNode {
    for (;;) {
        const t = newMarkIri(view.value);
        if (!g.match(t).length && !g.match(null, null, t).length) return t;
    }
}

/** The IRIs of the elements of a view: placements (`p`) and marks (`m`). */
export type ViewPart = 'p' | 'm';

export const viewPartBase = (view: string, part: ViewPart) => `${view}/${part}/`;
/** `<view>/m/<id>`, `id` 6 random base-36 characters (markIri checks that it is free). */
export const newMarkIri = (view: string): NamedNode => rdf.namedNode(viewPartBase(view, 'm') + [...randomBytes(6)].map(b => (b % 36).toString(36)).join(''));

/**
 * The IRI of the placement of `placed` (an element, or a triple for a connector) in `view`: `<view>/p/<hash>`, 12 hex characters of the
 * placed term. A view places an element or a triple at most once, so the IRI is unique and the same at each placement.
 */
export const placementIri = (view: string, placed: Term): NamedNode =>
    rdf.namedNode(viewPartBase(view, 'p') + createHash('sha256').update(termKey(placed)).digest('hex').slice(0, 12));
