// The records of the read models (Doc) from SPARQL rows: instances and relations (`instanceRecords`), and one view (`projectView`).
// view-read.ts and scoped-doc.ts build request-scoped Docs with them (ADR 0012: no shared projection). The reads do not change the
// dataset: statements that a read model cannot show stay in the dataset and in the saved file; the warnings list them.
// Each getter of a store term is a WASM call, so every term of a result row is read once (Plain).

import {
    Box, DEFAULT_COLLECTION_SIZE, DEFAULT_NOTE_SIZE, DEFAULT_SIZE, DEFAULT_VIEW_REFERENCE_SIZE, Doc, EdgeLayout, GROUP_SIZE, Instance, NS, SIDES, Side, View, ViewGroup,
    ViewArrow, ViewCard, ViewCollection, ViewNote, ViewReference, localName, pills, termKey, termToJSON
} from '@catenary/model';
import type { NamedNode, Term } from '@rdfjs/types';
import { ModelGraph, P, cmp, labelFromIri } from './graph';
import { elementId, relationId } from './ids';
import { rdf, termKey as rdfTermKey } from './terms';


const TYPE = P.type.value, LABEL = P.label.value, PREF_LABEL = NS.skos + 'prefLabel';

/** A term of a result row, read once. */
export type Plain = { termType: Term['termType']; value: string; term: Term };
export type Row = Record<string, Plain>;

export function select(g: ModelGraph, query: string): Row[] {
    return g.select(query).map(r => {
        const row: Row = {};
        for (const k in r) row[k] = { termType: r[k].termType, value: r[k].value, term: r[k] };
        return row;
    });
}

/** Key of a term: a blank node and an IRI with the same value are different. */
export const key = (t: Plain) => t.termType === 'Literal' || t.termType === 'Quad' ? rdfTermKey(t.term) : t.termType + ' ' + t.value;

/** First term in value order (stable: equal values keep the row order). */
export const first = (ts: Plain[] | undefined) => ts && [...ts].sort((a, b) => cmp(a.value, b.value))[0];

const number = (ts: Plain[] | undefined, fallback: number) => {
    const v = first(ts)?.value;
    return v === undefined || isNaN(Number(v)) ? fallback : Number(v);
};

export type Triple = { s: string; p: string; o: string };

/** Order of triples (subject, predicate, object) by IRI. */
export const byTriple = (a: Triple, b: Triple) => cmp(a.s, b.s) || cmp(a.p, b.p) || cmp(a.o, b.o);

/** Subject in a view graph with its values: property -> objects, in row order. */
export type Resource = { s: Plain; values: Map<string, Plain[]> };

/** Statements of one subject: the rows (s, p, o) of its graph. */
export type Statements = { s: Plain; rows: Row[] };

/**
 * Instances and relations of `doc` from the statements of the instance subjects: label (rdfs:label, else skos:prefLabel, else from the
 * IRI), types, fields; a statement whose object is one of the subjects is a relation. `files`: the file of a vocabulary subject.
 * Returns the ids by IRI and by triple (`s p o`).
 */
export function instanceRecords(doc: Doc, statements: Statements[], files: Map<string, string>, warnings: string[]): { instanceIds: Map<string, string>; relationIds: Map<string, string> } {
    const subjects = [...statements].sort((a, b) => cmp(a.s.value, b.s.value));
    const instanceIds = new Map<string, string>();
    for (const e of subjects) instanceIds.set(e.s.value, elementId(rdf.namedNode(e.s.value)));
    const isInstance = (t: Plain) => t.termType === 'NamedNode' && instanceIds.has(t.value);

    const relations: Triple[] = [];
    for (const { s, rows } of subjects) {
        const labels = rows.filter(r => r.p.value === LABEL).map(r => r.o);
        const inst: Instance = {
            id: instanceIds.get(s.value)!,
            // rdfs:label, else skos:prefLabel (a SKOS concept or scheme), else from the IRI.
            label: labels.filter(o => o.termType === 'Literal').map(o => o.value).sort(cmp)[0]
                ?? rows.filter(r => r.p.value === PREF_LABEL && r.o.termType === 'Literal').map(r => r.o.value).sort(cmp)[0] ?? labelFromIri(s.value),
            uri: s.value,
            types: rows.filter(r => r.p.value === TYPE).map(r => r.o.value).sort(cmp),
            fields: {},
            ...(files.has(s.value) ? { file: files.get(s.value) } : {})
        };
        if (labels.length > 1) warnings.push(`${s.value}: more than one rdfs:label, shows "${inst.label}"`);
        for (const { p, o } of rows) {
            if (p.value === TYPE || p.value === LABEL) continue;
            if (isInstance(o)) {
                relations.push({ s: s.value, p: p.value, o: o.value });
                continue;
            }
            const t = termToJSON(o.term);
            if (t) (inst.fields[p.value] ??= []).push(t);
            else warnings.push(`${s.value} ${localName(p.value)}: blank node value kept in the file, not shown`);
        }
        for (const p of Object.keys(inst.fields)) inst.fields[p].sort((a, b) => cmp(termKey(a), termKey(b)));
        doc.instances[inst.id] = inst;
    }
    const relationIds = new Map<string, string>();
    for (const t of relations.sort(byTriple)) {
        const id = relationId(rdf.namedNode(t.s), rdf.namedNode(t.p), rdf.namedNode(t.o));
        relationIds.set(`${t.s} ${t.p} ${t.o}`, id);
        doc.relations[id] = { id, subject: instanceIds.get(t.s)!, predicate: t.p, object: instanceIds.get(t.o)! };
    }
    return { instanceIds, relationIds };
}

/**
 * IRI -> element id of everything a view can place: pills, instances, node shapes, value sets, and property shapes (an edge). A shape wins
 * over an instance, an instance over a class pill. The view read (view-read.ts) uses it.
 */
export function cardIdsOf(instanceIds: Map<string, string>, shapes: Doc['shapes']): Map<string, string> {
    return new Map([...[...pills(shapes)].map(([id, { iri }]) => [iri, id] as const), ...instanceIds, ...shapesCardIds(shapes)]);
}

export function shapesCardIds(shapes: Doc['shapes']): Map<string, string> {
    const { nodeShapes, valueSets, properties } = shapes;
    const ids = new Map<string, string>();
    for (const n of Object.values(nodeShapes)) ids.set(n.uri, n.id);
    for (const v of Object.values(valueSets)) ids.set(v.uri, v.id);
    for (const p of Object.values(properties)) if (p.uri && p.id.startsWith('n-')) ids.set(p.uri, p.id);
    return ids;
}

export function projectView(
    graph: string, label: string,
    parts: { cards: Resource[]; edges: Resource[]; groups: Resource[]; notes: Resource[]; references: Resource[]; fileReferences?: Resource[]; collections: Resource[]; arrows: Resource[] },
    instanceIds: Map<string, string>, relationIds: Map<string, string>, viewIds: Map<string, string>, warnings: string[],
    arrowStatements: Set<string> = new Set(), properties: ReadonlySet<string> = new Set()
): View {
    const view: View = { id: elementId(rdf.namedNode(graph)), label, uri: graph, boxes: [], edges: [], arrows: [] };
    const vals = (r: Resource, p: string) => r.values.get(p);
    const str = (r: Resource, p: string) => first(vals(r, p))?.value;
    const num = (r: Resource, p: string, d: number) => number(vals(r, p), d);
    const idOf = (r: Resource) => elementId(r.s.term as NamedNode);
    /** Box and color of a view-owned box. */
    const base = (r: Resource, size: { width: number; height: number }) => {
        const color = str(r, 'color');
        return { id: idOf(r), x: num(r, 'x', 0), y: num(r, 'y', 0), width: num(r, 'width', size.width), height: num(r, 'height', size.height), ...(color ? { color } : {}) };
    };
    const byPlace = (a: Box, b: Box) => a.y - b.y || a.x - b.x;

    const groups = parts.groups.map((r): ViewGroup => ({ kind: 'group', ...base(r, GROUP_SIZE), label: str(r, 'label') ?? '' }));
    groups.sort((a, b) => byPlace(a, b) || cmp(a.label, b.label) || cmp(a.id, b.id));

    const notes = parts.notes.map((r): ViewNote => ({ kind: 'note', ...base(r, DEFAULT_NOTE_SIZE), text: str(r, 'text') ?? '' }));
    notes.sort((a, b) => byPlace(a, b) || cmp(a.text, b.text) || cmp(a.id, b.id));

    const references: ViewReference[] = [];
    for (const r of parts.references) {
        const target = first(vals(r, 'references'));
        const targetId = target?.termType === 'NamedNode' ? viewIds.get(target.value) : undefined;
        if (!targetId) { warnings.push(`${label}: reference to unknown view ${target?.value} kept in the file, not shown`); continue; }
        references.push({ kind: 'reference', ...base(r, DEFAULT_VIEW_REFERENCE_SIZE), target: targetId });
    }
    for (const r of parts.fileReferences ?? []) {
        const file = str(r, 'file');
        if (!file) { warnings.push(`${label}: file reference without view:file kept in the file, not shown`); continue; }
        references.push({ kind: 'reference', ...base(r, DEFAULT_VIEW_REFERENCE_SIZE), file });
    }
    references.sort((a, b) => byPlace(a, b) || cmp(a.target ?? a.file ?? '', b.target ?? b.file ?? '') || cmp(a.id, b.id));

    // A card has the id of its view:Placement subject (spec/ui-manifest.hs §2); `element`: the id of what it places.
    const cards = new Map<string, ViewCard>();
    for (const r of parts.cards) {
        const target = first(vals(r, 'element'));
        // The placement of a list figure ("in", "one of", hub; ADR 0014 rule 12): the notation engine reads it (notation-schema.ts).
        if (target?.value.startsWith('urn:trellis:list:')) continue;
        const instance = target?.termType === 'NamedNode' ? instanceIds.get(target.value) : undefined;
        if (!instance) { warnings.push(`${label}: node for unknown instance ${target?.value} kept in the file, not shown`); continue; }
        if (cards.has(target!.value)) { warnings.push(`${label}: ${target!.value} placed twice, shows one`); continue; }
        const display = str(r, 'display') === 'simple' ? 'simple' as const : undefined;
        // The placement of a property edge is not drawn under its placement id (an edge, or the pill of one property `<element>_leaf`):
        // its box keeps the id of its element.
        const propertyEdge = properties.has(instance);
        cards.set(target!.value, { kind: 'card', ...base(r, DEFAULT_SIZE), ...(propertyEdge ? { id: instance } : {}), element: instance, ...(display ? { display } : {}) });
    }

    // Members: instances in no other collection of the view. A member has no placement of its own (ADR 0014, C1); a file before it can
    // still have one.
    const collected = new Set<string>();
    /** Member IRI → the id of its collection: an arrow to a member ends at the collection. */
    const memberBox = new Map<string, string>();
    const collections = parts.collections.map((r): ViewCollection => {
        const members: string[] = [];
        for (const m of (vals(r, 'member') ?? []).map(t => t.value).sort(cmp)) {
            const id = cards.get(m)?.element ?? instanceIds.get(m);
            if (!id) { warnings.push(`${label}: collection member that is not an instance kept in the file, not shown: ${m}`); continue; }
            if (collected.has(m)) { warnings.push(`${label}: ${m} is in two collections, shows in one`); continue; }
            collected.add(m);
            memberBox.set(m, idOf(r));
            members.push(id);
        }
        return { kind: 'collection', ...base(r, DEFAULT_COLLECTION_SIZE), members };
    });
    collections.sort((a, b) => byPlace(a, b) || cmp(a.id, b.id));
    view.boxes = [...groups, ...notes, ...references, ...[...cards.keys()].sort(cmp).map(t => cards.get(t)!), ...collections];

    const edges: { triple: Triple; layout: EdgeLayout }[] = [];
    const placed = new Set<string>();
    const shown = (iri: string) => cards.has(iri) || collected.has(iri);
    for (const r of parts.edges) {
        const [s, p, o] = ['subject', 'predicate', 'object'].map(x => first(vals(r, x)));
        const iris = s?.termType === 'NamedNode' && p?.termType === 'NamedNode' && o?.termType === 'NamedNode';
        const relation = iris ? relationIds.get(`${s.value} ${p.value} ${o.value}`) : undefined;
        if (!relation) { warnings.push(`${label}: placement of an unknown relation kept in the file, not shown`); continue; }
        if (!shown(s!.value) || !shown(o!.value)) {
            warnings.push(`${label}: placement of a relation without both ends in the view kept in the file, not shown`);
            continue;
        }
        const e: EdgeLayout = { id: idOf(r), relation };
        const fromSide = str(r, 'fromSide'), toSide = str(r, 'toSide'), color = str(r, 'color');
        if (fromSide && SIDES.includes(fromSide as Side)) e.fromSide = fromSide as Side;
        if (toSide && SIDES.includes(toSide as Side)) e.toSide = toSide as Side;
        if (color) e.color = color;
        if (placed.has(relation)) continue;
        placed.add(relation);
        edges.push({ triple: { s: s!.value, p: p!.value, o: o!.value }, layout: e });
    }
    // A relation with both ends in the view and no placement: hidden (the read model keeps the flag of the user interface).
    // A relation with an end in an entity group needs no placement: it is part of the bundle of the group (ADR 0014, nt:linkEnd).
    for (const [k, relation] of relationIds) {
        if (placed.has(relation)) continue;
        const [s, p, o] = k.split(' ');
        if (shown(s) && shown(o)) edges.push({ triple: { s, p, o }, layout: collected.has(s) || collected.has(o) ? { relation } : { relation, hidden: true } });
    }
    view.edges = edges.sort((a, b) => byTriple(a.triple, b.triple)).map(e => e.layout);

    // Arrow ends: the boxes of the elements of the statement in this view (the id of their placement).
    const boxOfElement = new Map<string, string>();
    for (const r of parts.cards) {
        const target = first(vals(r, 'element'));
        const card = target && cards.get(target.value);
        if (card) boxOfElement.set(key(target), card.id);
    }
    for (const r of [...parts.groups, ...parts.notes, ...parts.references, ...parts.fileReferences ?? [], ...parts.collections]) {
        const e = first(vals(r, 'element'));
        if (e) boxOfElement.set(key(e), idOf(r));
    }
    const arrows: ViewArrow[] = [];
    for (const r of parts.arrows) {
        const [s, o] = ['subject', 'object'].map(p => first(vals(r, p)));
        const [from, to] = [s, o].map(t => t && (boxOfElement.get(key(t)) ?? memberBox.get(t.value)));
        if (!s || !o || !arrowStatements.has(`${key(s)} ${key(o)}`)) { warnings.push(`${label}: placement of an unknown arrow kept in the file, not shown`); continue; }
        if (!from || !to) { warnings.push(`${label}: arrow without two ends in the view kept in the file, not shown`); continue; }
        const color = str(r, 'color');
        arrows.push({ id: idOf(r), from, to, ...(color ? { color } : {}) });
    }
    view.arrows = arrows.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.id, b.id));
    return view;
}
