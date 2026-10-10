// The read model of the whole dataset in one Doc: the projection that ModelStore used before ADR 0012. Test only: tests use it to
// build Doc fixtures for the pure functions of @catenary/model. Production code builds request-scoped Docs (scoped-doc.ts).

import {
    Doc, NS, PREFIXES as PREFIX_TABLE, emptyDoc
} from '@catenary/model';
import type { Term } from '@rdfjs/types';
import { MODEL_GRAPH, ModelGraph, P, VALIDATION_GRAPH, cmp, fileOfGraph, labelFromIri } from '../src/graph';
import { elementId } from '../src/ids';
import { Plain, Resource, Row, cardIdsOf, first, instanceRecords, key, projectView, select } from '../src/records';
import { readShapes } from '../src/shapes-read';
import { rdf } from '../src/terms';

export interface Projection { doc: Doc; warnings: string[] }

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX view: <${NS.view}>`;
const TYPE = P.type.value, LABEL = P.label.value, CONFORMS_TO = P.conformsTo.value;

/**
 * The shapes read model of the shapes and vocabulary quads, read again only when these quads or the prefix table change (readShapes
 * compacts IRIs with it). The key is the content, not ModelGraph.keys.shapes: the oracle stays independent of the cache of the
 * store (shapesIndexOf).
 */
const shapesRead = new WeakMap<ModelGraph, { key: string; shapes: Doc['shapes'] }>();
function shapesOf(g: ModelGraph): Doc['shapes'] {
    const quads = g.shapesAndVocabulary();
    const key = JSON.stringify(PREFIX_TABLE) + '\n' + quads.map(q => `${key4(q.subject)} ${q.predicate.value} ${key4(q.object)} ${q.graph.value}`).join('\n');
    const cached = shapesRead.get(g);
    if (cached?.key === key) return cached.shapes;
    const shapes = readShapes(quads).model;
    shapesRead.set(g, { key, shapes });
    return shapes;
}
const key4 = (t: Term): string => t.termType === 'Literal' ? JSON.stringify([t.value, t.language, t.datatype.value]) : `${t.termType}:${t.value}`;

export function project(g: ModelGraph): Projection {
    const warnings: string[] = [];
    const doc = emptyDoc();
    const M = `<${g.model.value}>`;
    doc.shapes = shapesOf(g);

    // Model graph: all statements, grouped by subject.
    const statements = new Map<string, { s: Plain; rows: Row[] }>();
    for (const r of select(g, `SELECT ?s ?p ?o WHERE { GRAPH ${M} { ?s ?p ?o } }`)) {
        const k = key(r.s);
        let e = statements.get(k);
        if (!e) statements.set(k, e = { s: r.s, rows: [] });
        e.rows.push(r);
    }
    const self = statements.get('NamedNode ' + MODEL_GRAPH);
    const conformsTo = first(self?.rows.filter(r => r.p.value === CONFORMS_TO).map(r => r.o));
    if (conformsTo) doc.conformsTo = conformsTo.value;

    // Instance: an IRI subject (not the model graph IRI) with an rdf:type or an rdfs:label; and a SKOS subject of a shapes graph
    // (ModelGraph.isInstance), with its statements of that graph.
    const plain = (t: Term): Plain => ({ termType: t.termType, value: t.value, term: t });
    const files = new Map<string, string>();
    const vocabulary = [...g.vocabularySubjects()].map(([iri, graph]) => {
        files.set(iri, fileOfGraph(graph.value));
        const rows = g.match(rdf.namedNode(iri), null, null, graph).map(q => ({ s: plain(q.subject), p: plain(q.predicate), o: plain(q.object) }));
        return { s: rows[0].s, rows };
    });
    const subjects = [...[...statements.values()].filter(e => e.s.termType === 'NamedNode' && e !== self && e.rows.some(r => r.p.value === TYPE || r.p.value === LABEL)), ...vocabulary];
    const { instanceIds, relationIds } = instanceRecords(doc, subjects, files, warnings);
    const isInstance = (t: Plain) => t.termType === 'NamedNode' && instanceIds.has(t.value);

    for (const { s, rows } of statements.values()) {
        if (s === self?.s) {
            for (const r of rows) if (r.p.value !== CONFORMS_TO) warnings.push(`statement about the model graph kept in the file, not shown: ${r.p.value}`);
        } else if (!isInstance(s)) {
            warnings.push(`subject without rdf:type or rdfs:label kept in the file, not shown: ${s.value}`);
        }
    }

    // Named graphs other than the model graph and the shapes graphs, with their view:View subjects and labels.
    const graphs = new Map<string, { views: Map<string, { v: Plain; labels: Plain[] }> }>();
    for (const r of select(g, `${PREFIXES}
        SELECT ?g ?v ?l WHERE {
            { SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER (isIRI(?g) && ?g NOT IN (${[...g.dataGraphs(), ...g.shapesGraphs(), rdf.namedNode(VALIDATION_GRAPH)].map(t => `<${t.value}>`).join(', ')})) } }
            OPTIONAL { GRAPH ?g { ?v a view:View OPTIONAL { ?v rdfs:label ?l } } }
        }`)) {
        let e = graphs.get(r.g.value);
        if (!e) graphs.set(r.g.value, e = { views: new Map() });
        if (!r.v) continue;
        let v = e.views.get(key(r.v));
        if (!v) e.views.set(key(r.v), v = { v: r.v, labels: [] });
        if (r.l) v.labels.push(r.l);
    }

    const cardIds = cardIdsOf(instanceIds, doc.shapes);
    const properties = new Set(Object.keys(doc.shapes.properties));
    // A placement of a card has view:element; a placement of a relation or an arrow reifies its triple (rdf:reifies). A placement
    // of a mark (frame, note, file reference, entity group) takes the content of the mark; a placement of a view is a view reference.
    // The records of marks and references have the placement as subject (the box id) and the values of placement and mark.
    const placements = resources(g, 'Placement', ['element', 'subject', 'predicate', 'object', 'x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide']);
    const marks = new Map<string, { kind: 'groups' | 'notes' | 'fileReferences' | 'collections'; r: Resource }>();
    for (const [type, kind, props] of [['Frame', 'groups', ['label']], ['Note', 'notes', ['text']], ['FileRef', 'fileReferences', ['file']], ['EntityGroup', 'collections', ['member']]] as const) {
        for (const rs of resources(g, type, [...props]).values()) for (const r of rs) marks.set(key(r.s), { kind, r });
    }
    const isViewIri = (t: Plain | undefined) => !!t && t.termType === 'NamedNode' && (graphs.get(t.value)?.views.size ?? 0) > 0;
    type Kind = 'cards' | 'edges' | 'arrows' | 'groups' | 'notes' | 'references' | 'fileReferences' | 'collections';
    const byKind = new Map<string, Record<Kind, Resource[]>>();
    for (const [graph, rs] of placements) {
        const k: Record<Kind, Resource[]> = { cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], fileReferences: [], collections: [] };
        byKind.set(graph, k);
        for (const r of rs) {
            const e = first(r.values.get('element'));
            const mark = e && marks.get(key(e));
            if (!e && r.values.has('subject')) (first(r.values.get('predicate'))?.value === NS.view + 'arrow' ? k.arrows : k.edges).push(r);
            else if (mark) k[mark.kind].push({ s: r.s, values: new Map([...mark.r.values, ...r.values]) });
            else if (isViewIri(e)) k.references.push({ s: r.s, values: new Map([...r.values, ['references', [e!]]]) });
            else k.cards.push(r);
        }
    }
    const part = (graph: string, kind: Kind) => byKind.get(graph)?.[kind] ?? [];
    // Arrows: statements `x view:arrow y` (in any graph); a placement shows one in a view.
    const arrowStatements = new Set(select(g, `${PREFIXES} SELECT ?s ?o WHERE { GRAPH ?g { ?s view:arrow ?o } }`).map(r => `${key(r.s)} ${key(r.o)}`));
    const viewIds = new Map([...graphs.keys()].map(graph => [graph, elementId(rdf.namedNode(graph))]));
    for (const graph of [...graphs.keys()].sort(cmp)) {
        const views = [...graphs.get(graph)!.views.values()];
        if (!views.length) {
            warnings.push(`graph ${graph} has no view:View, kept in the file, not shown`);
            continue;
        }
        const subject = views.sort((a, b) => cmp(a.v.value, b.v.value))[0];
        const label = subject.labels.filter(o => o.termType === 'Literal').map(o => o.value).sort(cmp)[0] ?? labelFromIri(subject.v.value);
        const parts = {
            cards: part(graph, 'cards'), edges: part(graph, 'edges'), groups: part(graph, 'groups'),
            notes: part(graph, 'notes'), references: part(graph, 'references'), fileReferences: part(graph, 'fileReferences'), collections: part(graph, 'collections'),
            arrows: part(graph, 'arrows')
        };
        const view = projectView(graph, label, parts, cardIds, relationIds, viewIds, warnings, arrowStatements, properties);
        const description = select(g, `${PREFIXES} SELECT ?text WHERE { GRAPH <${graph}> { <${graph}> view:description ?text } }`)[0]?.text;
        if (description?.termType === 'Literal') view.description = description.value;
        doc.views[view.id] = view;
    }
    return { doc, warnings: [...new Set(warnings)] };
}

/**
 * Subjects of one view type (Placement, Group, Note) in each named graph, with the values of `props` (view
 * properties; "label" is rdfs:label): graph IRI -> subjects in row order. One OPTIONAL for each property
 * gives one row for each subject; several values give more rows, and the values are kept once.
 */
function resources(g: ModelGraph, type: string, props: string[]): Map<string, Resource[]> {
    // subject, predicate, object: the parts of the triple term that the resource reifies (a placement of a connector).
    const parts = ['subject', 'predicate', 'object'];
    const optional = props.filter(p => !parts.includes(p)).map(p => `OPTIONAL { ?s ${p === 'label' ? 'rdfs:label' : 'view:' + p} ?${p} }`).join(' ')
        + (props.includes('subject') ? ' OPTIONAL { ?s rdf:reifies ?triple FILTER (isTRIPLE(?triple)) BIND (SUBJECT(?triple) AS ?subject) BIND (PREDICATE(?triple) AS ?predicate) BIND (OBJECT(?triple) AS ?object) }' : '');
    const out = new Map<string, Map<string, Resource>>();
    for (const r of select(g, `${PREFIXES}
        SELECT ?g ?s ${props.map(p => '?' + p).join(' ')} WHERE { GRAPH ?g { ?s a view:${type} ${optional} } }`)) {
        let inGraph = out.get(r.g.value);
        if (!inGraph) out.set(r.g.value, inGraph = new Map());
        let e = inGraph.get(key(r.s));
        if (!e) inGraph.set(key(r.s), e = { s: r.s, values: new Map() });
        for (const p of props) {
            const o = r[p];
            if (!o) continue;
            const os = e.values.get(p);
            if (!os) e.values.set(p, [o]);
            else if (!os.some(x => key(x) === key(o))) os.push(o);
        }
    }
    return new Map([...out].map(([graph, m]) => [graph, [...m.values()]]));
}

