// Outline displays placement geometry, shared labels and placed connections. The shapes index supplies card IDs.

import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { Box, Classes, DEFAULT_SIZE, GROUP_SIZE, NS, OutlineNode, ShapesModel, groupAmong, predicateName } from '@catenary/model';
import { ModelGraph, cmp } from './graph';
import { elementId, elementTerm, relationId } from './ids';
import { shapesCardIds } from './records';
import { connections, construct, graphStatements, iri, labels, statements, things } from './sparql';
import { rdf, termKey } from './terms';

export interface OutlineContext {
    g: ModelGraph;
    meta: Classes;
    shapes: ShapesModel;
}
export interface OutlineSelection { view?: string; ids: string[] }

const MARKS = ['Frame', 'Note', 'FileRef', 'EntityGroup'].map(m => NS.view + m);
const values = (quads: Quad[], s: string, p: string): Term[] => quads.filter(q => q.subject.value === s && q.predicate.value === p).map(q => q.object).sort((a, b) => cmp(a.value, b.value));
const first = (quads: Quad[], s: string, p: string) => values(quads, s, p)[0];
const number = (quads: Quad[], s: string, p: string, fallback: number) => {
    const value = first(quads, s, NS.view + p)?.value;
    return value === undefined || isNaN(Number(value)) ? fallback : Number(value);
};
type Card = Box & { id: string; element: string; iri: string };
type Group = Box & { id: string; label: string };

/** Outline of one view. Geometry supplies frame containment. */
export function outline(ctx: OutlineContext, viewId: string, selection: OutlineSelection = { ids: [] }): OutlineNode[] {
    const { g, meta } = ctx;
    const V = elementTerm(viewId);
    if (!V) return [];
    const data = graphStatements(g, V.value);
    if (!values(data, V.value, NS.rdf + 'type').some(t => t.value === NS.view + 'View')) return [];
    const placements = [...new Set(data.filter(q => q.predicate.value === NS.rdf + 'type' && q.object.value === NS.view + 'Placement').map(q => q.subject.value))].sort(cmp);
    const elements = [...new Set(data.filter(q => q.predicate.value === NS.view + 'element').map(q => q.object.value))];
    const facts = statements(g, elements);
    const names = labels(g, elements);
    const typed = elements.length ? construct(g, `CONSTRUCT { ?s rdf:type ?type } WHERE {
        VALUES ?s { ${elements.map(iri).join(' ')} } { ${things()} }
    }`) : [];
    const known = new Set(typed.map(q => q.subject.value));
    const shapeIds = shapesCardIds(ctx.shapes);
    const properties = new Set(Object.keys(ctx.shapes.properties));
    const cardIdOf = (s: string) => shapeIds.get(s) ?? (known.has(s) ? elementId(rdf.namedNode(s)) : undefined);
    const groups: Group[] = [];
    const cards = new Map<string, Card>();
    for (const pl of placements) {
        const e = first(data, pl, NS.view + 'element')?.value;
        if (!e) continue;
        const types = values(facts, e, NS.rdf + 'type').map(t => t.value);
        const marks = types.filter(t => MARKS.includes(t));
        const box = (size: { width: number; height: number }) => ({
            x: number(data, pl, 'x', 0), y: number(data, pl, 'y', 0),
            width: number(data, pl, 'width', size.width), height: number(data, pl, 'height', size.height)
        });
        const id = elementId(rdf.namedNode(pl));
        if (marks.length) {
            if (marks.length === 1 && marks[0] === NS.view + 'Frame') groups.push({ id, label: names.get(e)!, ...box(GROUP_SIZE) });
            continue;
        }
        if (types.includes(NS.view + 'View')) continue;
        const element = cardIdOf(e);
        if (!element || cards.has(e)) continue;
        cards.set(e, { id: properties.has(element) ? element : id, element, iri: e, ...box(DEFAULT_SIZE) });
    }
    groups.sort((a, b) => a.y - b.y || a.x - b.x || cmp(a.label, b.label) || cmp(a.id, b.id));
    const cardList = [...cards.values()].sort((a, b) => cmp(a.iri, b.iri));
    const links = cardList.length ? construct(g, `CONSTRUCT { ?s ?p ?o } WHERE {
        VALUES ?s { ${cardList.map(c => iri(c.iri)).join(' ')} } ${connections()}
    }`) : [];
    const existing = new Set(links.map(termKey));
    const edges = new Map<string, { s: string; p: string; o: string; placement: string }>();
    for (const pl of placements) {
        if (first(data, pl, NS.view + 'element')) continue;
        const triple = first(data, pl, NS.rdf + 'reifies');
        if (triple?.termType !== 'Quad') continue;
        const { subject: s, predicate: p, object: o } = triple;
        if (s.termType !== 'NamedNode' || o.termType !== 'NamedNode' || !cards.has(s.value) || !cards.has(o.value) || !existing.has(termKey(triple))) continue;
        const id = relationId(s, p as NamedNode, o);
        if (!edges.has(id)) edges.set(id, { s: s.value, p: p.value, o: o.value, placement: elementId(rdf.namedNode(pl)) });
    }
    const relations = [...edges].sort(([, a], [, b]) => cmp(a.s, b.s) || cmp(a.p, b.p) || cmp(a.o, b.o));
    const selected = selectedIds(g, viewId, selection, cardIdOf);
    const node = (kind: OutlineNode['kind'], key: string, name: string, element: string, target?: string): OutlineNode => ({
        kind, key, name, element, selected: selected.ids.has(element) || target !== undefined && (selected.ids.has(target) || selected.elements.has(target)), children: []
    });
    const byName = (a: OutlineNode, b: OutlineNode) => a.name.localeCompare(b.name);
    const card = (c: Card): OutlineNode => {
        const n = node('card', c.id, names.get(c.iri)!, c.id, c.element);
        for (const [id, r] of relations) if (r.s === c.iri) n.children.push(node('out', id, `${predicateName(meta, r.p)} → ${names.get(r.o)}`, r.placement, id));
        for (const [id, r] of relations) if (r.o === c.iri) n.children.push(node('in', id, `${predicateName(meta, r.p)} ← ${names.get(r.s)}`, r.placement, id));
        return n;
    };
    const parentOf = (b: Box & { id: string }) => groupAmong(groups, b, b.id)?.id;
    const group = (gr: Group): OutlineNode => {
        const n = node('group', gr.id, gr.label || '(group)', gr.id);
        groups.filter(x => parentOf(x) === gr.id).map(group).sort(byName).forEach(x => n.children.push(x));
        cardList.filter(c => parentOf(c) === gr.id).map(card).sort(byName).forEach(x => n.children.push(x));
        return n;
    };
    return [...groups.filter(x => !parentOf(x)).map(group).sort(byName), ...cardList.filter(c => !parentOf(c)).map(card).sort(byName)];
}

/** A selection from another view resolves through its placement statements. */
function selectedIds(g: ModelGraph, viewId: string, selection: OutlineSelection, cardIdOf: (s: string) => string | undefined): { ids: Set<string>; elements: Set<string> } {
    if (selection.view === viewId) return { ids: new Set(selection.ids), elements: new Set() };
    const elements = new Set(selection.ids);
    const S = selection.view ? elementTerm(selection.view) : undefined;
    if (S) {
        const data = graphStatements(g, S.value);
        for (const id of selection.ids) {
            const pl = elementTerm(id);
            if (!pl) continue;
            const e = first(data, pl.value, NS.view + 'element');
            const triple = first(data, pl.value, NS.rdf + 'reifies');
            const element = e ? cardIdOf(e.value) : triple?.termType === 'Quad' && triple.subject.termType === 'NamedNode' && triple.object.termType === 'NamedNode'
                ? relationId(triple.subject, triple.predicate as NamedNode, triple.object) : undefined;
            if (element) elements.add(element);
        }
    }
    return { ids: new Set(), elements };
}
