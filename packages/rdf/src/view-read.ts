// The input of the view diagram (ADR 0007 step 5): the Doc of one view, from SPARQL rows of its view graph and of the model,
// without a projection of a part store. Rows per part: placements of the view graph (cards, placed edges, arrows, references),
// the marks they place (frames, notes, file references, collections, in any graph), the statements of the placed elements, the
// views that the part names (labels), the arrow statements. The rows become records with the rules of records.ts
// (`instanceRecords`, `projectView`), so the view diagram and the request-scoped read models (scoped-doc.ts) have one rule each.

import type { NamedNode, Term } from '@rdfjs/types';
import { Doc, NS, ShapesModel, emptyDoc } from '@catenary/model';
import { UNION_GRAPH, ModelGraph, REPORT_GRAPH, cmp, fileOfGraph } from './graph';
import { elementId, elementTerm, relationTriple } from './ids';
import { Plain, Resource, Statements, cardIdsOf, first, instanceRecords, key, projectView, select } from './records';
import { shapesIndexOf } from './shapes-read';
import { instancesAmong } from './sparql';
import { rdf } from './terms';
import { tracer } from './trace';
import { isView } from './views';
import { homeOf, P, SKOS_MEMBERSHIP, SKOS_TYPES, labelFromIri } from './vocabulary';

export interface ViewReadContext {
    g: ModelGraph;
    /** The shapes model of the store (readShapes of the shapes graphs and the SKOS vocabulary of the data file). */
    shapes: ShapesModel;
}

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX view: <${NS.view}> PREFIX skos: <${NS.skos}>`;
const MARKS = [['Frame', 'groups', 'label'], ['Note', 'notes', 'text'], ['FileRef', 'fileReferences', 'file'], ['EntityGroup', 'collections', 'member']] as const;
const MARK_TYPES = MARKS.map(([t]) => `view:${t}`).join(', ');
const PLACEMENT_PROPS = ['element', 'x', 'y', 'width', 'height', 'color', 'display', 'fromSide', 'toSide', 'vertices'];

/**
 * A view shows shape elements when it places a subject of a shapes graph, or a concept scheme or collection of the data file
 * (a value set card). Then the instances also include the SKOS vocabulary (a value set card lists its concepts).
 */
export function showsShapes(g: ModelGraph, view: NamedNode): boolean {
    const valueSetTypes = SKOS_TYPES.filter(t => !t.value.endsWith('#Concept'));
    return g.match(null, rdf.namedNode(NS.view + 'element'), null, view)
        .some(q => q.object.termType === 'NamedNode' && (g.match(q.object).some(x => g.isShapesGraph(x.graph))
            || valueSetTypes.some(t => g.match(q.object as NamedNode, P.type, t, g.union).length > 0)));
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
export function readView(g: ModelGraph, viewId: string, shapes?: ShapesModel, warnings: string[] = [], elements?: string[]): Doc {
    const view = elementTerm(viewId);
    if (!view || view.termType !== 'NamedNode' || !isView(g, view)) return emptyDoc();
    return tracer.span('refresh', elements ? 'read selected view' : 'read full view', () => {
        tracer.note(`view ${viewId}; IRI ${view.value}`);
        const doc = viewRead({ g, shapes: shapes ?? shapesIndexOf(g).model }, view, warnings, elements);
        const v = doc.views[viewId];
        tracer.note(`view ${viewId}; IRI ${view.value}; instances ${Object.keys(doc.instances).length}; placements ${(v?.boxes.length ?? 0) + (v?.edges.length ?? 0)}`);
        return doc;
    });
}

/** The Doc of view `view`: the view, the instances it places (and the SKOS vocabulary when it shows shapes), their relations. */
export function viewRead(ctx: ViewReadContext, view: NamedNode, warnings: string[] = [], elements?: string[]): Doc {
    const { g } = ctx;
    const V = `<${view.value}>`, M = `<${g.union.value}>`;
    const doc = emptyDoc();
    doc.shapes = ctx.shapes;
    const shows = !elements && showsShapes(g, view);
    // Resolve only the requested placements. Shape parts also need their owner card. The store reads of this resolution come in
    // one query each for all elements (§11.3 readBudgetMs): the view statements of the element terms, the frames among them and
    // their contents, the collections with a term as member, the placements of the requested terms.
    const requested = new Set<string>();
    const placementIds = new Set<string>();
    const list = (iris: Iterable<string>) => [...iris].map(s => `<${s}>`).join(', ');
    const values = (iris: Iterable<string>) => [...iris].map(s => `<${s}>`).join(' ');
    // The value sets by member IRI once, not a scan of the value sets for each element.
    const setsOfMember = new Map<string, string[]>();
    for (const set of Object.values(ctx.shapes.valueSets)) for (const m of set.members) setsOfMember.set(m.uri, [...setsOfMember.get(m.uri) ?? [], set.uri]);
    // The collections (any graph) with a term as member, for the terms that `add` sees.
    const memberOf = new Map<string, string[]>();
    const readMembers = (terms: Iterable<string>) => {
        const missing = [...new Set(terms)].filter(t => !memberOf.has(t));
        if (!missing.length) return;
        for (const t of missing) memberOf.set(t, []);
        for (const r of select(g, `${PREFIXES} SELECT ?c ?m WHERE { VALUES ?m { ${values(missing)} } GRAPH ?mg { ?c view:member ?m } }`)) {
            memberOf.get(r.m.value)!.push(r.c.value);
        }
    };
    const add = (id: string) => {
        const part = ctx.shapes.properties[id] ?? ctx.shapes.constraints[id];
        const owner = part && ctx.shapes.nodeShapes[part.owner];
        const term = elementTerm(id);
        if (term) {
            requested.add(term.value);
            for (const set of setsOfMember.get(term.value) ?? []) requested.add(set);
            for (const c of memberOf.get(term.value) ?? []) requested.add(c);
        }
        if (owner) requested.add(owner.uri);
        if (part && "uri" in part && part.uri) requested.add(part.uri);
        const triple = relationTriple(id);
        if (triple) { requested.add(triple.s.value); requested.add(triple.o.value); }
    };
    /** The placements of each IRI in the view graph (one query for all IRIs). */
    const placementsOf = (iris: Iterable<string>): Map<string, string[]> => {
        const out = new Map<string, string[]>();
        const terms = [...new Set(iris)];
        if (!terms.length) return out;
        for (const r of select(g, `${PREFIXES} SELECT ?pl ?e WHERE { VALUES ?e { ${values(terms)} } GRAPH ${V} { ?pl view:element ?e } }`)) {
            out.set(r.e.value, [...out.get(r.e.value) ?? [], r.pl.value]);
        }
        return out;
    };
    if (elements) {
        const ids = [...new Set(elements)];
        const terms = new Map(ids.flatMap(id => { const t = elementTerm(id); return t ? [[id, t.value] as const] : []; }));
        // The view statements of the element terms: the targets of placements, the triples of placed relations.
        const viewRows = terms.size ? select(g, `${PREFIXES} SELECT ?s ?p ?o ?ts ?to WHERE { VALUES ?s { ${values(terms.values())} } GRAPH ${V} { ?s ?p ?o }
            BIND (SUBJECT(?o) AS ?ts) BIND (OBJECT(?o) AS ?to) }`) : [];
        const statementsOf = new Map<string, typeof viewRows>();
        for (const r of viewRows) statementsOf.set(r.s.value, [...statementsOf.get(r.s.value) ?? [], r]);
        const targets = viewRows.flatMap(r => r.p.value === NS.view + 'element' && r.o.termType === 'NamedNode' ? [r.o.value] : []);
        // The frames among the placed terms, with their geometry, and the placements inside each frame.
        const frames = terms.size ? select(g, `${PREFIXES} SELECT ?pl ?x ?y ?w ?h WHERE { VALUES ?pl { ${values(statementsOf.keys())} }
            GRAPH ${V} { ?pl view:element ?t OPTIONAL { ?pl view:x ?x } OPTIONAL { ?pl view:y ?y } OPTIONAL { ?pl view:width ?w } OPTIONAL { ?pl view:height ?h } }
            GRAPH ?fg { ?t a view:Frame } }`) : [];
        const seenFrames = new Set<string>();
        const boxes = frames.filter(f => !seenFrames.has(f.pl.value) && seenFrames.add(f.pl.value)).map(f => {
            const number = (t: Plain | undefined, fallback: number) => { const n = Number(t?.value ?? fallback); return isNaN(n) ? fallback : n; };
            const x = number(f.x, 0), y = number(f.y, 0);
            return `(${x} ${y} ${x + number(f.w, 400)} ${y + number(f.h, 300)})`;
        });
        const inFrames = boxes.length ? select(g, `${PREFIXES} SELECT DISTINCT ?e WHERE { VALUES (?fx ?fy ?fx2 ?fy2) { ${boxes.join(' ')} } GRAPH ${V} {
            ?pl a view:Placement ; view:element ?e .
            OPTIONAL { ?pl view:x ?x } OPTIONAL { ?pl view:y ?y }
            OPTIONAL { ?pl view:width ?w } OPTIONAL { ?pl view:height ?h }
            FILTER (COALESCE(?x, 0) >= ?fx && COALESCE(?y, 0) >= ?fy
                && COALESCE(?x, 0) + COALESCE(?w, 640) <= ?fx2
                && COALESCE(?y, 0) + COALESCE(?h, 320) <= ?fy2)
        } }`).map(r => elementId(r.e.term as NamedNode)) : [];
        readMembers([...terms.values(), ...targets, ...inFrames.flatMap(id => elementTerm(id)?.value ?? [])]);
        for (const id of ids) {
            add(id);
            const term = terms.get(id);
            if (term === undefined) continue;
            for (const r of statementsOf.get(term) ?? []) {
                placementIds.add(term);
                if (r.p.value === NS.view + 'element' && r.o.termType === 'NamedNode') add(elementId(r.o.term as NamedNode));
                if (r.p.value === NS.rdf + 'reifies' && r.ts && r.to) {
                    for (const t of [r.ts, r.to]) if (t.termType === 'NamedNode') requested.add(t.value);
                }
            }
        }
        inFrames.forEach(add);
        for (const pls of placementsOf(requested).values()) pls.forEach(pl => placementIds.add(pl));
    }
    // Placements and group members are the bounded subject set. Avoid a correlated placement query for each object.
    const placed = new Set(select(g, `${PREFIXES} SELECT DISTINCT ?e WHERE {
        ${elements ? `VALUES ?pl { ${values(placementIds)} }` : ''}
        GRAPH ${V} { ?pl a view:Placement ; view:element ?e }
    }`).map(r => r.e.value));
    const members = placed.size ? select(g, `${PREFIXES} SELECT DISTINCT ?e WHERE {
        VALUES ?group { ${values(placed)} } GRAPH ?mg { ?group a view:EntityGroup ; view:member ?e }
    }`).map(r => r.e.value) : [];
    members.forEach(e => placed.add(e));
    if (elements) requested.forEach(e => placed.add(e));
    const rows = select(g, `${PREFIXES} SELECT DISTINCT ?s ?p ?o WHERE {
        { VALUES ?s { ${values(placed)} } GRAPH ${M} { ?s ?p ?o }
          ${elements ? '' : `FILTER (?p = rdf:type || !isIRI(?o) || ?o IN (${list(placed) || '<urn:trellis:none>'}) || NOT EXISTS { GRAPH ${M} { ?o rdf:type|rdfs:label ?any } })`} }
        ${shows ? `UNION { GRAPH ${M} { ?s a ?skos FILTER (?skos IN (skos:ConceptScheme, skos:Concept, skos:Collection)) ?s ?p ?o } }` : ''}
    }`);
    const statements = new Map<string, Statements>();
    for (const r of rows) {
        let e = statements.get(key(r.s));
        if (!e) statements.set(key(r.s), e = { s: r.s, rows: [] });
        e.rows.push({ s: r.s, p: r.p, o: r.o });
    }
    const TYPE = P.type.value, LABEL = P.label.value;
    const subjects = [...statements.values()].filter(e => e.s.termType === 'NamedNode' && e.s.value !== UNION_GRAPH && e.rows.some(r => r.p.value === TYPE || r.p.value === LABEL));
    // A view with shape elements: the SKOS subjects of the shapes graphs that are not instances above (vocabulary.ts vocabularySubjects
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
    // The instance check of the placed terms in one query, and the subjects by value: no scan per placed term.
    const placedInstances = elements ? instancesAmong(g, placed) : new Set<string>();
    const subjectValues = new Set(subjects.map(s => s.s.value));
    if (elements) for (const iri of placed) {
        if (!placedInstances.has(iri)) continue;
        if (subjectValues.has(iri)) continue;
        const home = homeOf(g, rdf.namedNode(iri));
        if (home.equals(g.union)) continue;
        const rows = g.match(rdf.namedNode(iri), null, null, home).map(q => ({ s: { termType: q.subject.termType, value: q.subject.value, term: q.subject } as Plain,
            p: { termType: q.predicate.termType, value: q.predicate.value, term: q.predicate } as Plain,
            o: { termType: q.object.termType, value: q.object.value, term: q.object } as Plain }));
        if (rows.length) { subjects.push({ s: rows[0].s, rows }); files.set(iri, fileOfGraph(home.value)); }
    }
    const { instanceIds, relationIds } = instanceRecords(doc, subjects, files, warnings);

    if (elements) {
        for (const pls of placementsOf(placed).values()) pls.forEach(pl => placementIds.add(pl));
        // The placements of the relations of the read model: one query for all triples.
        const triples = Object.keys(doc.relations).map(id => { const t = relationTriple(id)!; return `(<${t.s.value}> <${t.p.value}> <${t.o.value}>)`; });
        if (triples.length) for (const r of select(g, `${PREFIXES} SELECT ?pl WHERE { VALUES (?s ?p ?o) { ${triples.join(' ')} } GRAPH ${V} { ?pl rdf:reifies <<( ?s ?p ?o )>> } }`)) {
            placementIds.add(r.pl.value);
        }
    }
    const placementScope = (variable: string) => elements ? `VALUES ?${variable} { ${values(placementIds)} }` : '';

    // Views that the part names: this view, the targets of its view references, the graphs of the marks and arrows it places.
    const excluded = [...g.dataGraphs(), ...g.shapesGraphs(), rdf.namedNode(REPORT_GRAPH)].map(t => `<${t.value}>`).join(', ');
    const viewRows = select(g, `${PREFIXES}
        SELECT DISTINCT ?g ?v ?l WHERE {
            { BIND(${V} AS ?g) }
            UNION { ${placementScope("ref")} GRAPH ${V} { ?ref a view:Placement ; view:element ?g } }
            UNION { ${placementScope("m")} GRAPH ${V} { ?m a view:Placement ; view:element ?x } GRAPH ?g { ?x a ?mt FILTER (?mt IN (${MARK_TYPES})) } }
            UNION { ${placementScope("ap")} GRAPH ${V} { ?ap rdf:reifies <<( ?ax view:arrow ?ay )>> } GRAPH ?g { ?ax view:arrow ?ay } }
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
        SELECT ?s ${PLACEMENT_PROPS.map(p => '?' + p).join(' ')} ?subject ?predicate ?object WHERE { ${placementScope('s')} GRAPH ${V} { ?s a view:Placement
            ${PLACEMENT_PROPS.map(p => `OPTIONAL { ?s view:${p} ?${p} }`).join(' ')}
            OPTIONAL { ?s rdf:reifies ?triple FILTER (isTRIPLE(?triple)) BIND (SUBJECT(?triple) AS ?subject) BIND (PREDICATE(?triple) AS ?predicate) BIND (OBJECT(?triple) AS ?object) } } }`),
    [...PLACEMENT_PROPS, 'subject', 'predicate', 'object']);
    // The marks that the placements place (any graph), with their content. A subject with two mark types: the last of MARKS.
    const markRows = select(g, `${PREFIXES}
        SELECT ?s ?mt ?label ?text ?file ?member WHERE {
            { SELECT DISTINCT ?s WHERE { ${placementScope("pl")} GRAPH ${V} { ?pl a view:Placement ; view:element ?s } } }
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
        SELECT DISTINCT ?s ?o WHERE { ${placementScope("ap")} GRAPH ${V} { ?ap rdf:reifies <<( ?s view:arrow ?o )>> } GRAPH ?ag { ?s view:arrow ?o } }`).map(r => `${key(r.s)} ${key(r.o)}`));

    // Cards: instances, node shapes, value sets, and properties drawn out of their cards (by IRI). A shape wins over an instance.
    const cardIds = cardIdsOf(instanceIds, ctx.shapes);
    const properties = new Set(Object.keys(ctx.shapes.properties));
    for (const graph of [...views.keys()].sort(cmp)) {
        const empty = { cards: [], edges: [], arrows: [], groups: [], notes: [], references: [], fileReferences: [], collections: [] };
        const v = projectView(graph, labelOf(graph), graph === view.value ? parts : empty, cardIds, relationIds, viewIds, warnings, arrowStatements, properties);
        const description = g.match(rdf.namedNode(graph), rdf.namedNode(NS.view + 'description'), null, rdf.namedNode(graph))[0]?.object;
        if (description?.termType === 'Literal') v.description = description.value;
        doc.views[v.id] = v;
    }
    return doc;
}

/** Label of every view (view id → label): the first view:View subject of the graph; rdfs:label, else from the IRI. */
export function viewLabels(g: ModelGraph): Record<string, string> {
    const excluded = [...g.dataGraphs(), ...g.shapesGraphs(), rdf.namedNode(REPORT_GRAPH)].map(t => `<${t.value}>`).join(', ');
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
