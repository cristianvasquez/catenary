// The input of the view diagram (ADR 0007 step 5): the Doc of one view, from SPARQL rows of its view graph and of the model,
// without a projection of a part store. Rows per part: placements of the view graph (cards, placed edges, arrows, references),
// the marks they place (frames, notes, file references, collections, in any graph), the statements of the placed elements, the
// views that the part names (labels), the arrow statements. The rows become records with the rules of project.ts
// (`instanceRecords`, `projectView`), so the view diagram and the read model of the whole model have one rule each.

import type { NamedNode, Term } from '@rdfjs/types';
import { Doc, NS, ShapesModel, emptyDoc } from '@catenary/model';
import { MODEL_GRAPH, ModelGraph, P, SKOS_MEMBERSHIP, SKOS_TYPES, VALIDATION_GRAPH, cmp, fileOfGraph, labelFromIri } from './graph';
import { elementId, elementTerm } from './ids';
import { Plain, Resource, Statements, cardIdsOf, first, instanceRecords, key, projectView, select } from './records';
import { shapesIndexOf } from './shapes-read';
import { rdf } from './terms';

export interface ViewReadContext {
    g: ModelGraph;
    /** The shapes model of the store (readShapes of the shapes graphs and the SKOS vocabulary of the data file). */
    shapes: ShapesModel;
}

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX view: <${NS.view}> PREFIX skos: <${NS.skos}>`;
const MARKS = [['Frame', 'groups', 'label'], ['Note', 'notes', 'text'], ['FileRef', 'fileReferences', 'file'], ['EntityGroup', 'collections', 'member']] as const;
const MARK_TYPES = MARKS.map(([t]) => `view:${t}`).join(', ');
const PLACEMENT_PROPS = ['element', 'x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide'];

/**
 * A view shows shape elements when it places a subject of a shapes graph, or a concept scheme or collection of the data file
 * (a value set card). Then the instances also include the SKOS vocabulary (a value set card lists its concepts).
 */
export function showsShapes(g: ModelGraph, view: NamedNode): boolean {
    const valueSetTypes = SKOS_TYPES.filter(t => !t.value.endsWith('#Concept'));
    return g.match(null, rdf.namedNode(NS.view + 'element'), null, view)
        .some(q => q.object.termType === 'NamedNode' && (g.match(q.object).some(x => g.isShapesGraph(x.graph))
            || valueSetTypes.some(t => g.match(q.object as NamedNode, P.type, t, g.model).length > 0)));
}

/** Rows grouped by `?s`, values of `vars` once each in row order. */
function resources(rows: Record<string, Plain>[], vars: readonly string[]): Resource[] {
    const out = new Map<string, Resource>();
    for (const r of rows) {
        let e = out.get(key(r.s));
        if (!e) out.set(key(r.s), e = { s: r.s, values: new Map() });
        for (const v of vars) {
            const o = r[v];
            if (!o) continue;
            const os = e.values.get(v);
            if (!os) e.values.set(v, [o]);
            else if (!os.some(x => key(x) === key(o))) os.push(o);
        }
    }
    return [...out.values()];
}

/**
 * The Doc of the view `viewId` (viewRead); `shapes`: default, read from the store. An empty Doc when `viewId` is not a view.
 * `warnings`: receives what the view cannot show.
 */
export function readView(g: ModelGraph, viewId: string, shapes?: ShapesModel, warnings: string[] = []): Doc {
    const view = elementTerm(viewId);
    if (!view || view.termType !== 'NamedNode' || !g.isView(view)) return emptyDoc();
    return viewRead({ g, shapes: shapes ?? shapesIndexOf(g).model }, view, warnings);
}

/** The Doc of view `view`: the view, the instances it places (and the SKOS vocabulary when it shows shapes), their relations. */
export function viewRead(ctx: ViewReadContext, view: NamedNode, warnings: string[] = []): Doc {
    const { g } = ctx;
    const V = `<${view.value}>`, M = `<${g.model.value}>`;
    const doc = emptyDoc();
    doc.shapes = ctx.shapes;
    const shows = showsShapes(g, view);

    // Statements of the placed elements in the model graph. An IRI object that is an instance outside the view is left out (a relation
    // to an element not shown). A view with shape elements: also the statements of the SKOS subjects of the data file.
    // A member of an entity group placed in the view counts as placed: it has no placement of its own (ADR 0014, C1).
    const member = (x: string, n: string) => `{ GRAPH ${V} { ?${n} a view:Placement ; view:element ?${n}g } GRAPH ?${n}mg { ?${n}g a view:EntityGroup ; view:member ?${x} } }`;
    const placed = (x: string) => `EXISTS { { GRAPH ${V} { ?n_${x} a view:Placement ; view:element ?${x} } } UNION ${member(x, `m_${x}`)} }`;
    const rows = select(g, `${PREFIXES}
        SELECT DISTINCT ?s ?p ?o WHERE {
            { { GRAPH ${V} { ?n a view:Placement ; view:element ?s } } UNION ${member('s', 'ms')}
              GRAPH ${M} { ?s ?p ?o }
              FILTER (!isIRI(?o) || NOT EXISTS { GRAPH ${M} { ?o rdf:type|rdfs:label ?any } } || ${placed('o')}) }
            ${shows ? `UNION { GRAPH ${M} { ?s a ?skos FILTER (?skos IN (skos:ConceptScheme, skos:Concept, skos:Collection)) ?s ?p ?o } }` : ''}
        }`);
    const statements = new Map<string, Statements>();
    for (const r of rows) {
        let e = statements.get(key(r.s));
        if (!e) statements.set(key(r.s), e = { s: r.s, rows: [] });
        e.rows.push({ s: r.s, p: r.p, o: r.o });
    }
    const TYPE = P.type.value, LABEL = P.label.value;
    const subjects = [...statements.values()].filter(e => e.s.termType === 'NamedNode' && e.s.value !== MODEL_GRAPH && e.rows.some(r => r.p.value === TYPE || r.p.value === LABEL));
    // A view with shape elements: the SKOS subjects of the shapes graphs that are not instances above (ModelGraph.vocabularySubjects
    // on these statements), with their statements of the first such shapes graph.
    const files = new Map<string, string>();
    if (shows) {
        const plain = (t: Term): Plain => ({ termType: t.termType, value: t.value, term: t });
        const known = new Set(subjects.map(e => e.s.value));
        for (const graph of g.shapesGraphs()) {
            const found = [...SKOS_TYPES.flatMap(t => g.match(null, P.type, t, graph)), ...SKOS_MEMBERSHIP.flatMap(p => g.match(null, p, null, graph))];
            for (const q of found) {
                const iri = q.subject.value;
                if (q.subject.termType !== 'NamedNode' || known.has(iri)) continue;
                known.add(iri);
                files.set(iri, fileOfGraph(graph.value));
                const rs = g.match(q.subject, null, null, graph).map(x => ({ s: plain(x.subject), p: plain(x.predicate), o: plain(x.object) }));
                subjects.push({ s: rs[0].s, rows: rs });
            }
        }
    }
    const { instanceIds, relationIds } = instanceRecords(doc, subjects, files, warnings);

    // Views that the part names: this view, the targets of its view references, the graphs of the marks and arrows it places.
    const excluded = [g.model, ...g.shapesGraphs(), rdf.namedNode(VALIDATION_GRAPH)].map(t => `<${t.value}>`).join(', ');
    const viewRows = select(g, `${PREFIXES}
        SELECT DISTINCT ?g ?v ?l WHERE {
            { BIND(${V} AS ?g) }
            UNION { GRAPH ${V} { ?ref a view:Placement ; view:element ?g } }
            UNION { GRAPH ${V} { ?m a view:Placement ; view:element ?x } GRAPH ?g { ?x a ?mt FILTER (?mt IN (${MARK_TYPES})) } }
            UNION { GRAPH ${V} { ?ap rdf:reifies <<( ?ax view:arrow ?ay )>> } GRAPH ?g { ?ax view:arrow ?ay } }
            GRAPH ?g { ?v a view:View OPTIONAL { ?v rdfs:label ?l } }
            FILTER (isIRI(?g) && ?g NOT IN (${excluded}))
        }`);
    const views = new Map<string, Map<string, { v: Plain; labels: Plain[] }>>();
    for (const r of viewRows) {
        let e = views.get(r.g.value);
        if (!e) views.set(r.g.value, e = new Map());
        let v = e.get(key(r.v));
        if (!v) e.set(key(r.v), v = { v: r.v, labels: [] });
        if (r.l && !v.labels.some(x => key(x) === key(r.l))) v.labels.push(r.l);
    }
    if (!views.has(view.value)) return doc;
    const labelOf = (graph: string) => {
        const subject = [...views.get(graph)!.values()].sort((a, b) => cmp(a.v.value, b.v.value))[0];
        return subject.labels.filter(o => o.termType === 'Literal').map(o => o.value).sort(cmp)[0] ?? labelFromIri(subject.v.value);
    };
    const viewIds = new Map([...views.keys()].map(graph => [graph, elementId(rdf.namedNode(graph))]));

    // Placements of the view graph. A placement of a relation or an arrow reifies its triple.
    const placements = resources(select(g, `${PREFIXES}
        SELECT ?s ${PLACEMENT_PROPS.map(p => '?' + p).join(' ')} ?subject ?predicate ?object WHERE { GRAPH ${V} { ?s a view:Placement
            ${PLACEMENT_PROPS.map(p => `OPTIONAL { ?s view:${p} ?${p} }`).join(' ')}
            OPTIONAL { ?s rdf:reifies ?triple FILTER (isTRIPLE(?triple)) BIND (SUBJECT(?triple) AS ?subject) BIND (PREDICATE(?triple) AS ?predicate) BIND (OBJECT(?triple) AS ?object) } } }`),
    [...PLACEMENT_PROPS, 'subject', 'predicate', 'object']);
    // The marks that the placements place (any graph), with their content. A subject with two mark types: the last of MARKS.
    const markRows = select(g, `${PREFIXES}
        SELECT ?s ?mt ?label ?text ?file ?member WHERE {
            { SELECT DISTINCT ?s WHERE { GRAPH ${V} { ?pl a view:Placement ; view:element ?s } } }
            GRAPH ?mg { ?s a ?mt FILTER (?mt IN (${MARK_TYPES}))
                OPTIONAL { ?s rdfs:label ?label } OPTIONAL { ?s view:text ?text } OPTIONAL { ?s view:file ?file } OPTIONAL { ?s view:member ?member } } }`);
    const marks = new Map<string, { kind: typeof MARKS[number][1]; r: Resource }>();
    for (const [type, kind, prop] of MARKS) {
        for (const r of resources(markRows.filter(x => x.mt.value === NS.view + type), [prop])) marks.set(key(r.s), { kind, r });
    }
    const parts: Parameters<typeof projectView>[2] & { fileReferences: Resource[] } = {
        cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], fileReferences: [], collections: []
    };
    for (const r of placements) {
        const e = first(r.values.get('element'));
        const mark = e && marks.get(key(e));
        if (!e && r.values.has('subject')) (first(r.values.get('predicate'))?.value === NS.view + 'arrow' ? parts.arrows : parts.edges).push(r);
        else if (mark) parts[mark.kind].push({ s: r.s, values: new Map([...mark.r.values, ...r.values]) });
        else if (e && e.termType === 'NamedNode' && views.has(e.value)) parts.references.push({ s: r.s, values: new Map([...r.values, ['references', [e]]]) });
        else parts.cards.push(r);
    }
    // Arrows: a placement shows a statement `x view:arrow y` of any graph.
    const arrowStatements = new Set(select(g, `${PREFIXES}
        SELECT DISTINCT ?s ?o WHERE { GRAPH ${V} { ?ap rdf:reifies <<( ?s view:arrow ?o )>> } GRAPH ?ag { ?s view:arrow ?o } }`).map(r => `${key(r.s)} ${key(r.o)}`));

    // Cards: instances, node shapes, value sets, and properties drawn out of their cards (by IRI). A shape wins over an instance.
    const cardIds = cardIdsOf(instanceIds, ctx.shapes);
    const properties = new Set(Object.keys(ctx.shapes.properties));
    for (const graph of [...views.keys()].sort(cmp)) {
        const empty = { cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], fileReferences: [], collections: [] };
        const v = projectView(graph, labelOf(graph), graph === view.value ? parts : empty, cardIds, relationIds, viewIds, warnings, arrowStatements, properties);
        doc.views[v.id] = v;
    }
    return doc;
}

/** Label of every view (view id → label): the rule of project.ts (the first view:View subject of the graph; rdfs:label, else from the IRI). */
export function viewLabels(g: ModelGraph): Record<string, string> {
    const excluded = [g.model, ...g.shapesGraphs(), rdf.namedNode(VALIDATION_GRAPH)].map(t => `<${t.value}>`).join(', ');
    const subjects = new Map<string, Map<string, { v: string; labels: string[] }>>();
    for (const r of select(g, `${PREFIXES}
        SELECT ?g ?v ?l WHERE { GRAPH ?g { ?v a view:View OPTIONAL { ?v rdfs:label ?l FILTER (isLiteral(?l)) } } FILTER (isIRI(?g) && ?g NOT IN (${excluded})) }`)) {
        let e = subjects.get(r.g.value);
        if (!e) subjects.set(r.g.value, e = new Map());
        let v = e.get(key(r.v));
        if (!v) e.set(key(r.v), v = { v: r.v.value, labels: [] });
        if (r.l) v.labels.push(r.l.value);
    }
    return Object.fromEntries([...subjects].sort((a, b) => cmp(a[0], b[0])).map(([graph, vs]) => {
        const subject = [...vs.values()].sort((a, b) => cmp(a.v, b.v))[0];
        return [elementId(rdf.namedNode(graph)), subject.labels.sort(cmp)[0] ?? labelFromIri(subject.v)];
    }));
}
