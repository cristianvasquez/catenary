// Parts of the SHACL elements of a view that do not depend on the notation engine: card and pill sizes, the row of a property, the
// rows of a "one of" box, the class pill of a range, the halo of a node shape card. What a view draws: notation-schema.ts (ADR 0014).

import { Doc, View, ViewCard, boxes, byLabel, inView } from './doc';
import { ElementSchema, GraphOptions, LATENT_SUFFIX, LEAF_SUFFIX, TYPES, edgeLanes, memberListHeight } from './diagram-schema';
import { NodeShape, PropertyShape, Range, ShapesModel, SimpleRange, alternativesOf, cardinalityText, formatPath, pathParts, rangeKey, rangeText, shortIri, valueSetOf } from './shapes-doc';
import { iriId } from './ids';
import { NS, localName } from './terms';

/** Layout of a shape card: header, one row for each attribute, the "+ attribute" row. Model units. */
export const SHAPE_CARD = { head: 84, row: 28, add: 28, pad: 8 };
/** Same pill dimensions for placement and rendering. */
export const pillSize = (text: string) => ({ width: Math.min(280, Math.max(70, 18 + text.length * 7.2)), height: 26 });

/** Style of a pill or of a row value: datatype and node kind dashed, value set green, a shape or class solid blue. */
export type LeafStyle = 'datatype' | 'nodeKind' | 'any' | 'in' | 'scheme' | 'class' | 'or';

export function leafStyle(r: Range): LeafStyle {
    switch (r.kind) {
        case 'datatype': return 'datatype';
        case 'nodeKind': return 'nodeKind';
        case 'any': return 'any';
        case 'in': return 'in';
        case 'scheme': case 'collection': return 'scheme';
        case 'or': return 'or';
        default: return 'class';
    }
}

/** A row of the attribute list of a shape card: a property shape. */
export interface ShapeRow {
    type: typeof TYPES.ROW;
    id: string;
    parts: { text: string; color?: string }[];
    range: string;
    style: LeafStyle;
    card: string;
    violations: number;
    /** A relation to entities (sh:node, sh:class): "→ Target". */
    relation: boolean;
}

/** Height of a card with `rows` attribute rows, at card text `scale` (`GraphOptions.cardScale`). */
export function shapeCardHeight(rows: number, scale = 1): number {
    return scale * (SHAPE_CARD.head + rows * SHAPE_CARD.row + SHAPE_CARD.add + SHAPE_CARD.pad);
}

/**
 * The view node id of a property taken out of its cards: the id of its IRI. A shared property (one IRI, several owners) has one
 * property id per owner but one view node. Without an IRI: its own id (the store gives no view node to a blank node).
 */
export function propertyNodeId(p: PropertyShape): string {
    return p.uri ? iriId(p.uri) : p.id;
}

/**
 * Why a property shape is not a line on its own (ADR 0014): a datatype, node-kind or open end is private to its line, and such a line
 * shows only as a member of a shown hub. Undefined: it can be a line (a member: its hub).
 */
export function lineProblem(p: PropertyShape): string | undefined {
    const priv = p.range.kind === 'datatype' || p.range.kind === 'nodeKind' || p.range.kind === 'any';
    return priv && !p.constraint ? 'A property with a datatype, a node kind or no range is a row. It shows as a line only as a member of a logical constraint.' : undefined;
}

/** The property has a line placement in `view`: a line from all its owner cards of this view. */
export function isTakenOut(view: View | undefined, p: PropertyShape): boolean {
    return inView(view, propertyNodeId(p));
}

/** The card that shows the target of a property: a node shape (sh:node; a class: its first node shape by id), a value set; else undefined. */
export function targetCard(shapes: ShapesModel, r: Range): string | undefined {
    return r.kind === 'or' || r.kind === 'any' ? undefined : alternativeCard(shapes, r);
}

/**
 * The IRI of the pill of a range: a datatype, a node kind (sh:IRI, …), or a class that no node shape targets. The pill is the element
 * with this IRI (id: `iriId`). A view has at most one pill for an IRI; the edges of all properties with this range end at it.
 */
export function pillIri(shapes: ShapesModel, r: Range): string | undefined {
    if (r.kind === 'class' && !Object.values(shapes.nodeShapes).some(n => n.targetClass === r.class)) return r.class;
    return undefined;
}

/** The element id of the pill of a range (`pillIri`). */
export function pillId(shapes: ShapesModel, r: Range): string | undefined {
    const iri = pillIri(shapes, r);
    return iri && iriId(iri);
}

/** The pill elements of the shapes: element id -> its IRI and the range that it shows (of the first property with this pill). */
export function pills(shapes: ShapesModel): Map<string, { iri: string; range: SimpleRange }> {
    const out = new Map<string, { iri: string; range: SimpleRange }>();
    for (const p of Object.values(shapes.properties)) {
        const iri = pillIri(shapes, p.range);
        if (iri && !out.has(iriId(iri))) out.set(iriId(iri), { iri, range: p.range as SimpleRange });
    }
    return out;
}

/** Width of a "one of" card. */
export const ONE_OF_WIDTH = 240;

/** A row of a "one of" card: an alternative. `takeOut`: the id of the card that shows it (node shape, value set), else empty. */
export interface AlternativeRow { key: string; label: string; sub: string; style: LeafStyle; takeOut: string; takeOutTitle: string }

/** The card that shows an alternative: a node shape (sh:node; for a class, its first node shape by id), a value set; else undefined. */
export function alternativeCard(shapes: ShapesModel, a: SimpleRange): string | undefined {
    if (a.kind === 'node') return shapes.nodeShapes[a.shape] ? a.shape : undefined;
    if (a.kind === 'class') return Object.values(shapes.nodeShapes).filter(s => s.targetClass === a.class).map(s => s.id).sort((x, y) => x.localeCompare(y))[0];
    return valueSetOf(shapes, a);
}

const ALTERNATIVE_KIND: Record<SimpleRange['kind'], string> = {
    node: 'node shape', class: 'class', datatype: 'datatype', nodeKind: 'node kind', in: 'values', scheme: 'concept scheme', collection: 'collection'
};

/** Rows of the "one of" card of `p`: its alternatives without a card in the view (`target`). */
export function alternativeRows(shapes: ShapesModel, p: PropertyShape, target: (r: Range) => string | undefined, label: (iri: string) => string = localName): AlternativeRow[] {
    if (p.range.kind !== 'or') return [];
    return p.range.alternatives.filter(a => !target(a)).map(a => {
        const card = alternativeCard(shapes, a);
        return {
            key: rangeKey(a), label: rangeText(shapes, a, label), sub: ALTERNATIVE_KIND[a.kind], style: leafStyle(a), takeOut: card ?? '',
            takeOutTitle: card ? 'Show as a card' : a.kind === 'class' ? 'No node shape has this class as target class' : 'A datatype or node kind has no card'
        };
    });
}

/** Size of the target box of a property edge: a pill, or the "one of" card with `rows` rows. */
export function targetSize(shapes: ShapesModel, p: PropertyShape, rows: number, label: (iri: string) => string = localName, scale = 1): { width: number; height: number } {
    return p.range.kind === 'or' ? { width: ONE_OF_WIDTH * scale, height: memberListHeight(rows, scale) } : pillSize(rangeText(shapes, p.range, label));
}

/**
 * Node shapes that `view` does not show, with a property shape whose range points to node shape `id`: sh:node `id`, or sh:class of
 * its target class, also as an "or" alternative. A simple property path also points to `id` when it equals the shape's sh:targetSubjectsOf predicate.
 * The incoming halo button of a node shape card.
 */
export function hiddenShapeSources(shapes: ShapesModel, view: View | undefined, id: string): { shape: NodeShape; properties: PropertyShape[] }[] {
    const target = shapes.nodeShapes[id];
    if (!target) return [];
    const points = (r: SimpleRange) => r.kind === 'node' ? r.shape === id : r.kind === 'class' && (target.targetClasses ?? [target.targetClass]).includes(r.class);
    const targetPredicate = (p: PropertyShape) => p.path.kind === 'iri' && (target.targetSubjectsOf?.includes(p.path.iri) || target.targetObjectsOf?.includes(p.path.iri));
    const found = new Map<string, PropertyShape[]>();
    for (const source of Object.values(shapes.nodeShapes)) if (source.id !== id && !inView(view, source.id) && source.nodes?.includes(target.uri)) found.set(source.id, []);
    for (const p of Object.values(shapes.properties)) {
        if (p.owner === id || !shapes.nodeShapes[p.owner] || inView(view, p.owner) || !(targetPredicate(p) || alternativesOf(p.range).some(points))) continue;
        found.set(p.owner, [...(found.get(p.owner) ?? []), p]);
    }
    return [...found].map(([owner, properties]) => ({ shape: shapes.nodeShapes[owner], properties })).sort((a, b) => byLabel(a.shape, b.shape));
}

