// Reference for test/project.test.ts: project() before the SPARQL rewrite (per-term match calls).
// Test only. ModelGraph.instances() and graphs() were removed from graph.ts; they are local functions here.

import {
    DEFAULT_SIZE, Doc, EdgeLayout, GROUP_SIZE, Instance, SIDES, Side, View, ViewCard, ViewGroup, emptyDoc, localName, termKey, termToJSON
} from '@catenary/model';
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import type { TermMap } from 'rdf-ext';
import { MODEL_GRAPH, ModelGraph, P, V, cmp, sorted } from '../src/graph';
import { elementId, relationId } from '../src/ids';
import { rdf } from '../src/terms';


/** Order of quads (subject, predicate, object) by IRI. */
const byTriple = (a: Quad, b: Quad) => cmp(a.subject.value, b.subject.value) || cmp(a.predicate.value, b.predicate.value) || cmp(a.object.value, b.object.value);

export function projectReference(g: ModelGraph): { doc: Doc; warnings: string[] } {
    const warnings: string[] = [];
    const doc = emptyDoc();
    const conformsTo = g.object(g.model, P.conformsTo);
    if (conformsTo) doc.conformsTo = conformsTo.value;

    const instanceIds = rdf.termMap<NamedNode, string>(instances(g).map(t => [t, elementId(t)]));
    const relations: Quad[] = [];
    for (const [s, id] of instanceIds) {
        const inst: Instance = {
            id, label: g.label(s), uri: s.value,
            types: sorted(rdf.termSet(g.objects(s, P.type))).map(t => t.value),
            fields: {}
        };
        if (g.objects(s, P.label).length > 1) warnings.push(`${s.value}: more than one rdfs:label, shows "${inst.label}"`);
        for (const q of g.match(s, null, null, g.model)) {
            if (q.predicate.equals(P.type) || q.predicate.equals(P.label)) continue;
            if (instanceIds.has(q.object)) {
                relations.push(q);
                continue;
            }
            const t = termToJSON(q.object);
            if (t) (inst.fields[q.predicate.value] ??= []).push(t);
            else warnings.push(`${s.value} ${localName(q.predicate.value)}: blank node value kept in the file, not shown`);
        }
        for (const p of Object.keys(inst.fields)) inst.fields[p].sort((a, b) => cmp(termKey(a), termKey(b)));
        doc.instances[id] = inst;
    }
    const relationIds = rdf.termMap<Quad, string>();
    for (const q of relations.sort(byTriple)) {
        const [s, p, o] = [q.subject, q.predicate, q.object] as NamedNode[];
        const id = relationId(s, p, o);
        relationIds.set(rdf.quad(s, p, o), id);
        doc.relations[id] = { id, subject: instanceIds.get(s)!, predicate: p.value, object: instanceIds.get(o)! };
    }

    for (const q of g.match(null, null, null, g.model)) {
        if (q.subject.equals(g.model)) {
            if (!q.predicate.equals(P.conformsTo)) warnings.push(`statement about the model graph kept in the file, not shown: ${q.predicate.value}`);
        } else if (!instanceIds.has(q.subject)) {
            warnings.push(`subject without rdf:type or rdfs:label kept in the file, not shown: ${q.subject.value}`);
        }
    }

    for (const graph of graphs(g)) {
        if (graph.equals(g.model)) continue;
        if (!g.isView(graph)) {
            warnings.push(`graph ${graph.value} has no view:View, kept in the file, not shown`);
            continue;
        }
        const view = projectView(g, graph, instanceIds, relationIds, warnings);
        doc.views[view.id] = view;
    }
    return { doc, warnings: [...new Set(warnings)] };
}

function projectView(
    g: ModelGraph, graph: NamedNode, instanceIds: TermMap<NamedNode, string>, relationIds: TermMap<Quad, string>, warnings: string[]
): View {
    const label = g.label(g.viewSubject(graph)!, graph);
    const view: View = { id: elementId(graph), label, uri: graph.value, boxes: [], edges: [], arrows: [] };
    const obj = (s: Term, p: Term) => g.object(s, p, graph);
    const str = (s: Term, p: Term) => obj(s, p)?.value;
    const num = (s: Term, p: Term, d: number) => g.number(s, p, graph, d);
    const box = (s: Term, size: { width: number; height: number }) => ({ x: num(s, V.x, 0), y: num(s, V.y, 0), width: num(s, V.width, size.width), height: num(s, V.height, size.height) });

    // A frame is a mark: its label is on the mark, its box and color on the placement.
    const mark = (s: Term) => obj(s, V.element);
    const groups = g.groups(graph).map(s => ({ s, label: g.match(mark(s) as NamedNode, P.label)[0]?.object.value ?? '', ...box(s, GROUP_SIZE), color: str(s, V.color) }));
    groups.sort((a, b) => a.y - b.y || a.x - b.x || cmp(a.label, b.label) || cmp(a.s.value, b.s.value));
    const groupBoxes = groups.map(({ s, color, label, ...rest }): ViewGroup => ({ kind: 'group', id: elementId(s as NamedNode), ...rest, ...(color ? { color } : {}), label }));

    const nodes = rdf.termMap<NamedNode, ViewCard>();
    const ofRelation = (s: Term) => !obj(s, V.element) && !!g.connectorOf(s, graph);
    const isMarkOrView = (s: Term) => { const e = mark(s); return !!e && (g.isView(e) || [V.Frame, V.Note, V.FileRef, V.EntityGroup].some(t => g.match(e as NamedNode, P.type, t).length > 0)); };
    for (const s of g.subjects(P.type, V.Placement, graph).filter(s => !ofRelation(s) && !isMarkOrView(s))) {
        const target = obj(s, V.element);
        const instance = target && instanceIds.get(target);
        if (!instance) { warnings.push(`${label}: node for unknown instance ${target?.value} kept in the file, not shown`); continue; }
        if (nodes.has(target)) { warnings.push(`${label}: ${target.value} placed twice, shows one`); continue; }
        const color = str(s, V.color);
        nodes.set(target as NamedNode, { kind: 'card', id: elementId(s as NamedNode), ...box(s, DEFAULT_SIZE), ...(color ? { color } : {}), element: instance });
    }
    view.boxes = [...groupBoxes, ...sorted(nodes.keys()).map(t => nodes.get(t)!)];

    const edges: { triple: Quad; layout: EdgeLayout }[] = [];
    const placed = new Set<string>();
    for (const s of g.subjects(P.type, V.Placement, graph).filter(ofRelation)) {
        const t = g.connectorOf(s, graph);
        const triple = t ? rdf.quad(t.subject as NamedNode, t.predicate as NamedNode, t.object) : undefined;
        const relation = triple && relationIds.get(triple);
        if (!triple || !relation) { warnings.push(`${label}: placement of an unknown relation kept in the file, not shown`); continue; }
        if (!nodes.has(triple.subject) || !nodes.has(triple.object)) {
            warnings.push(`${label}: placement of a relation without both ends in the view kept in the file, not shown`);
            continue;
        }
        const e: EdgeLayout = { id: elementId(s as NamedNode), relation };
        const fromSide = str(s, V.fromSide), toSide = str(s, V.toSide), color = str(s, V.color);
        if (fromSide && SIDES.includes(fromSide as Side)) e.fromSide = fromSide as Side;
        if (toSide && SIDES.includes(toSide as Side)) e.toSide = toSide as Side;
        if (color) e.color = color;
        if (placed.has(relation)) continue;
        placed.add(relation);
        edges.push({ triple, layout: e });
    }
    for (const [triple, relation] of relationIds) {
        if (!placed.has(relation) && nodes.has(triple.subject) && nodes.has(triple.object)) edges.push({ triple, layout: { relation, hidden: true } });
    }
    view.edges = edges.sort((a, b) => byTriple(a.triple, b.triple)).map(e => e.layout);
    return view;
}

/** Instance IRIs, sorted (was ModelGraph.instances). */
function instances(g: ModelGraph): NamedNode[] {
    const seen = rdf.termSet<NamedNode>();
    for (const q of [...g.match(null, P.type, null, g.model), ...g.match(null, P.label, null, g.model)]) {
        if (q.subject.termType === 'NamedNode' && q.subject.value !== MODEL_GRAPH) seen.add(q.subject);
    }
    return sorted(seen);
}

/** Named graphs, sorted, the model graph first (was ModelGraph.graphs). */
function graphs(g: ModelGraph): NamedNode[] {
    const seen = rdf.termSet<NamedNode>();
    for (const q of g.match()) if (q.graph.termType === 'NamedNode') seen.add(q.graph);
    seen.delete(g.model);
    return [g.model, ...sorted(seen)];
}
