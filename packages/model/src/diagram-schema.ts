import type { TargetMatch } from '@catenary/shacl/common';
// Doc + one view -> graph model schema (GLSP / Sprotty). Used by the GLSP server.
// Element ids (spec/ui-manifest.hs §2, a placement is not its element): card = placement id (`element`: instance id), edge =
// placement id (a relation that the view does not place: relation id), group = placement id, group name label = `<id>_label`,
// bundle = `<id of its first relation>_bundle`.

import { Doc, View, boxes, cardOf, edgeLayout, elementOfId, relationsInView } from './doc';
import { Classes, predicateName, primaryClass } from './metamodel';
import { localName } from './terms';
import type { Violation } from './validation';
import { type ViewFigures, partIsRow } from './notation-join';
import { idIri } from './ids';

export const TYPES = {
    GRAPH: 'graph',
    CARD: 'node:card',
    GROUP: 'node:group',
    NOTE: 'node:note',
    VIEW_REFERENCE: 'node:view-reference',
    COLLECTION: 'node:collection',
    RELATION: 'edge:relation',
    BUNDLE: 'edge:bundle',
    /** Informative arrow from or to a note (view only). */
    ARROW: 'edge:arrow',
    NAME: 'label:name',
    // Shape elements (shapes-schema.ts)
    SHAPE: 'node:shape',
    PROPERTY: 'edge:property',
    LEAF: 'node:leaf',
    LOGIC: 'node:logic',
    /** The "one of" box of a property (sh:or of ranges): a member list of its alternatives, as a value set or a collection. */
    ONE_OF: 'node:one-of',
    /** From the "one of" box of a property to the card of an alternative. */
    ALTERNATIVE: 'edge:alternative',
    /** A SKOS concept scheme or collection: a node with its concepts as member rows. */
    VALUESET: 'node:valueset',
    /** A row of the attribute list of a shape card: a property shape (child of the card). */
    ROW: 'label:row',
    /** A property shown as a row whose target is in the view: dashed, drawn while one of its ends is selected. */
    LATENT: 'edge:latent',
    /** A derived edge from a property shape to a shape that targets its subjects. */
    TARGETING: 'edge:targeting'
} as const;

export const LABEL_SUFFIX = '_label';
export const BUNDLE_SUFFIX = '_bundle';
/** Box of one property shape: its "in" or "one of" box, or its private pill: `<property element id>_leaf` (notation-schema.ts). A class pill is the element of its IRI (`pillIri`). */
export const LEAF_SUFFIX = '_leaf';
/** Dashed edge of a property shown as a row (`TYPES.LATENT`): `<property shape id>_latent`. */
export const LATENT_SUFFIX = '_latent';

/**
 * Member list of the container boxes (an instance collection, a SKOS scheme or collection, a "one of" box), in model units: header, one
 * row for each member, the add row. The box grows to show all rows. A member that has its own box in the view is a line, not a row.
 */
export const MEMBER_LIST = { head: 64, row: 46, add: 34, pad: 10 };
/** `scale`: the card text scale of the client (`GraphOptions.cardScale`); the rows grow with the text. */
export const memberListHeight = (rows: number, scale = 1) => scale * (MEMBER_LIST.head + rows * MEMBER_LIST.row + MEMBER_LIST.add + MEMBER_LIST.pad);

/** Element id of a label or a pill id: its owner. Other ids stay. */
export function ownerOfLabel(id: string): string {
    return id.endsWith(LABEL_SUFFIX) ? id.slice(0, -LABEL_SUFFIX.length) : id.endsWith(LEAF_SUFFIX) ? id.slice(0, -LEAF_SUFFIX.length) : id;
}

export interface ElementSchema {
    type: string;
    id: string;
    children?: ElementSchema[];
    [key: string]: unknown;
}

export interface GraphOptions {
    showHidden: boolean;
    violations: Violation[];
    /** Card text scale of the client (font preference "Card text" / its default): the minimum heights of cards with rows follow it. Default 1. */
    cardScale?: number;
    /** Label of a SKOS concept scheme (shape cards). */
    schemeLabel?: (iri: string) => string;
    /**
     * What the view does not show, for the halo buttons of a card: the related instances of an instance (`hiddenNeighbors`), the node
     * shapes with a property to a node shape (`hiddenShapeSources`). From the whole model, not from the part of the view.
     */
    hidden?: { neighbors: (instance: string) => { in: number; out: number; targets?: number } | undefined; shapeSources: (shape: string) => number };
    /** The figures of the view (ADR 0014): the SHACL and value-set elements come from their join. Absent: none are drawn. */
    notation?: ViewFigures;
    /** Checked instance-shape pairs for this view, supplied by the shared SHACL query. */
    applicability?: readonly TargetMatch[];
}

/** Count parallel edges in either direction. Call the returned allocator once per edge, in drawing order. */
export function edgeLanes(ends: readonly (readonly [string, string])[]): (a: string, b: string) => { lane: number; lanes: number } {
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const lanes = new Map<string, number>();
    for (const [a, b] of ends) lanes.set(pairKey(a, b), (lanes.get(pairKey(a, b)) ?? 0) + 1);
    const used = new Map<string, number>();
    return (a, b) => {
        const key = pairKey(a, b), n = used.get(key) ?? 0;
        used.set(key, n + 1);
        return { lane: n, lanes: lanes.get(key)! };
    };
}

/**
 * Instance cards, relation edges and collections of a view. `skip`: view nodes drawn as shape elements (a node shape wins over an
 * instance with the same IRI); they get no instance card and no relation edges.
 */
export function dataElements(doc: Doc, meta: Classes, view: View, opts: GraphOptions, skip: ReadonlySet<string>): { edges: ElementSchema[]; cards: ElementSchema[]; collections: ElementSchema[] } {
    const count = new Map<string, number>();
    for (const v of opts.violations) if (v.instance && v.severity === 'Violation') count.set(v.instance, (count.get(v.instance) ?? 0) + 1);

    // A member of a collection has no card: its edges go to the collection (`box`). Else the edges go to the card (its placement id).
    const collected = new Map(boxes(view, 'collection').flatMap(c => c.members.map(m => [m, c.id] as const)));
    const box = (instance: string) => collected.get(instance) ?? cardOf(view, instance)?.id ?? instance;
    const className = (types: string[]) => primaryClass(meta, types)?.name ?? (types.map(localName).join(', ') || 'no type');

    // The rows of an instance card come from the notation engine (ADR 0014, instance notation): the property shapes of all its classes
    // with a value, a logical constraint as a row group, a link whose other end the view does not show. The class is the header line.
    const engineRows = new Map((opts.notation?.join.boxes ?? []).filter(b => b.figure.fs.gather).map(b => [b.figure.focus.value, b.rows]));
    const cards: ElementSchema[] = boxes(view, 'card').filter(n => doc.instances[n.element] && !skip.has(n.element) && !collected.has(n.element)).map(n => {
        const inst = doc.instances[n.element];
        const cls = primaryClass(meta, inst.types);
        const lines: string[] = [];
        const rows = engineRows.get(inst.uri);
        if (rows) {
            for (const r of rows.filter(r => !r.text.startsWith('rdf:type: '))) lines.push(r.text, ...(r.sub ?? []).map(s => `  ${s.text}`));
        } else {
            const shownPaths = new Set<string>();
            for (const f of cls?.fields ?? []) {
                if (shownPaths.has(f.path)) continue;
                shownPaths.add(f.path);
                const values = inst.fields[f.path];
                if (values?.length) lines.push(`${f.name}: ${values.map(v => v.termType === 'NamedNode' ? localName(v.value) : v.value).join(', ')}`);
            }
        }
        return {
            type: TYPES.CARD, id: n.id, element: inst.id,
            position: { x: n.x, y: n.y }, size: { width: n.width, height: n.height },
            name: inst.label,
            className: className(inst.types),
            classColor: cls?.color ?? '', color: n.color ?? '', display: n.display ?? 'detailed',
            lines, violations: count.get(inst.id) ?? 0, known: !!cls,
            hiddenIn: opts.hidden?.neighbors(inst.id)?.in ?? 0, hiddenOut: opts.hidden?.neighbors(inst.id)?.out ?? 0,
            hiddenTargets: opts.hidden?.neighbors(inst.id)?.targets ?? 0
        };
    });

    const relations = relationsInView(doc, view)
        // A scheme or collection card has the id of its instance: its relations (skos:inScheme, skos:member, …) go to the card.
        .filter(r => [r.subject, r.object].every(id => !skip.has(id) || doc.shapes.valueSets[id]))
        .filter(r => opts.showHidden || !edgeLayout(view, r.id)?.hidden)
        .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    // Relations with an end in a collection: one bundle for each source box, predicate and target box (as Reactodia relation groups).
    const bundles = new Map<string, { id: string; source: string; target: string; predicate: string; count: number }>();
    const plain = relations.filter(r => {
        if (!collected.has(r.subject) && !collected.has(r.object)) return true;
        const source = box(r.subject), target = box(r.object);
        if (source === target) return false;
        const key = `${source} ${r.predicate} ${target}`;
        const bundle = bundles.get(key);
        if (bundle) bundle.count++;
        else bundles.set(key, { id: r.id + BUNDLE_SUFFIX, source, target, predicate: r.predicate, count: 1 });
        return false;
    });
    const lane = edgeLanes([...plain.map(r => [box(r.subject), box(r.object)] as const), ...[...bundles.values()].map(b => [b.source, b.target] as const)]);

    const edges: ElementSchema[] = [
        ...plain.map(r => {
            const layout = edgeLayout(view, r.id);
            return {
                type: TYPES.RELATION, id: layout?.id ?? r.id, element: r.id, sourceId: box(r.subject), targetId: box(r.object),
                name: predicateName(meta, r.predicate),
                fromSide: layout?.fromSide ?? '', toSide: layout?.toSide ?? '', color: layout?.color ?? '',
                hidden: layout?.hidden === true, ...lane(box(r.subject), box(r.object))
            };
        }),
        ...[...bundles.values()].map(b => ({
            type: TYPES.BUNDLE, id: b.id, sourceId: b.source, targetId: b.target, name: predicateName(meta, b.predicate), count: b.count,
            ...lane(b.source, b.target)
        }))
    ];

    // An entity group lists its members by the member-list rule (`partIsRow`), as the other containers.
    const groupBox = (id: string) => opts.notation?.join.boxes.find(b => b.figure.focus.value === idIri(id));
    const collections: ElementSchema[] = boxes(view, 'collection').map(c => {
        const isRow = partIsRow(groupBox(c.id));
        const members = c.members.filter(m => doc.instances[m] && isRow(doc.instances[m].uri));
        return {
            type: TYPES.COLLECTION, id: c.id, position: { x: c.x, y: c.y }, size: { width: c.width, height: Math.max(c.height, memberListHeight(members.length, opts.cardScale)) },
            color: c.color ?? '',
            members: members.map(m => {
                const inst = doc.instances[m];
                return { id: m, label: inst.label, className: className(inst.types), classColor: primaryClass(meta, inst.types)?.color ?? '' };
            }).sort((a, b) => a.label.localeCompare(b.label))
        };
    });

    return { edges, cards, collections };
}

/** Groups (large first), view references and notes of a view. */
export function viewElements(doc: Doc, view: View): { groups: ElementSchema[]; references: ElementSchema[]; notes: ElementSchema[] } {
    const groups: ElementSchema[] = [...boxes(view, 'group')]
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .map(g => ({
            type: TYPES.GROUP, id: g.id, position: { x: g.x, y: g.y }, size: { width: g.width, height: g.height },
            color: g.color ?? '',
            children: [{
                type: TYPES.NAME, id: g.id + LABEL_SUFFIX, text: g.label,
                position: { x: 6, y: -34 }, size: { width: Math.max(10, g.width - 12), height: 26 }
            }]
        }));
    const references: ElementSchema[] = boxes(view, 'reference').filter(r => r.file || (r.target && doc.views[r.target])).map(r => ({
        // GLSP reserves "target" for edges and drops it during serialization. A file reference: targetFile (absolute), broken.
        type: TYPES.VIEW_REFERENCE, id: r.id, color: r.color ?? '', position: { x: r.x, y: r.y }, size: { width: r.width, height: r.height },
        ...(r.file
            ? { targetViewId: '', targetFile: r.path ?? '', name: r.file.replace(/^.*\//, ''), broken: !!r.broken }
            : { targetViewId: r.target!, name: doc.views[r.target!].label })
    }));
    const notes: ElementSchema[] = boxes(view, 'note').map(n => ({
        type: TYPES.NOTE, id: n.id, text: n.text, color: n.color ?? '',
        position: { x: n.x, y: n.y }, size: { width: n.width, height: n.height }
    }));
    return { groups, references, notes };
}

/**
 * Arrows of a view whose two ends are drawn. `drawn`: ids of the drawn nodes. A collected card: its end goes to the collection; a property
 * drawn out of its card: to its pill.
 */
export function arrowElements(view: View, drawn: ReadonlySet<string>): ElementSchema[] {
    const collected = new Map(boxes(view, 'collection').flatMap(c => c.members.map(m => [m, c.id] as const)));
    // `id`: the placement id of a box; a collected card and a pill are found by the element of the placement.
    const end = (id: string) => [id, collected.get(elementOfId(view, id)), elementOfId(view, id) + LEAF_SUFFIX].find(x => x !== undefined && drawn.has(x));
    const arrows = view.arrows.map(a => ({ a, from: end(a.from), to: end(a.to) }))
        .filter((x): x is { a: typeof x.a; from: string; to: string } => !!x.from && !!x.to && x.from !== x.to);
    const lane = edgeLanes(arrows.map(x => [x.from, x.to] as const));
    return arrows.map(({ a, from, to }) => ({ type: TYPES.ARROW, id: a.id, sourceId: from, targetId: to, color: a.color ?? '', ...lane(from, to) }));
}
