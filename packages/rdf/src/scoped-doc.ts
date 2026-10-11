import { shapeTargetMatches } from './shacl-targets';
// Request-scoped read models (ADR 0012): a Doc with only the elements, neighbors and views that one request needs, from SPARQL rows.
// The store builds one for each request and keeps none. The records use the rules of records.ts (`instanceRecords`) and view-read.ts.
// Every view has an entry: the views that the scope does not read have their label only (no boxes, edges or arrows).

import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { Doc, NS, ShapesModel, View, boxes, emptyDoc } from '@catenary/model';
import { UNION_GRAPH, ModelGraph, REPORT_GRAPH, fileOfGraph, cmp } from './graph';
import { elementId, elementTerm, relationTriple } from './ids';
import { Plain, Statements, instanceRecords, key, select } from './records';
import { homesAmong, inModelAmong, instancesAmong } from './sparql';
import { rdf } from './terms';
import { ViewReadContext, readView, viewLabels } from './view-read';
import { homeOf, vocabularySubjects, P, labelFromIri } from './vocabulary';
import { isView, views as viewGraphs } from './views';

export interface DocScope {
    /** Element ids: instances, relations, views and shape elements. A placement id of one of `views` stands for its element. */
    elements?: string[];
    /** Also the instances related to the instances of `elements`, with the relations to them. */
    neighbors?: boolean;
    /** Views whose selected placements and dependencies are read. */
    selectionViews?: (string | undefined)[];
    /** Views to read in full. */
    views?: (string | undefined)[];
    /**
     * Also read every view that can show an element of `elements`: a view that places it, the ends of a relation, the value set of a
     * concept or the node shape of a shape element, or a view that refers to a view of `elements`.
     */
    showing?: boolean;
}

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX view: <${NS.view}>`;
const iri = (s: string) => `<${s}>`;
const plain = (t: Term): Plain => ({ termType: t.termType, value: t.value, term: t });

/** A view entry with its label only. */
const labelOnly = (id: string, label: string): View => ({ id, label, uri: elementTerm(id)?.value ?? '', boxes: [], edges: [], arrows: [] });

export function scopedDoc(ctx: ViewReadContext, scope: DocScope): Doc {
    const { g, shapes } = ctx;
    const doc = emptyDoc();
    doc.shapes = shapes;
    for (const [id, label] of Object.entries(viewLabels(g))) doc.views[id] = labelOnly(id, label);
    const read = new Set<string>();
    const readPart = (viewId: string, elements?: string[]) => {
        if (read.has(viewId) || !doc.views[viewId]) return;
        read.add(viewId);
        const part = readView(g, viewId, shapes, [], elements);
        if (part.views[viewId]) doc.views[viewId] = part.views[viewId];
        for (const [id, i] of Object.entries(part.instances)) doc.instances[id] ??= i;
        for (const [id, r] of Object.entries(part.relations)) doc.relations[id] ??= r;
    };
    const views = (scope.views ?? []).filter((v): v is string => !!v);
    views.forEach(v => readPart(v));
    const selectedViews = (scope.selectionViews ?? []).filter((v): v is string => !!v);
    selectedViews.forEach(v => readPart(v, scope.elements ?? []));

    // Elements: a placement id of a read view stands for its element. The placements of the read views by id once (elementOfId
    // scans the boxes of a view for each id).
    const elementOf = new Map<string, string>();
    for (const v of [...views, ...selectedViews].reverse()) {
        const view = doc.views[v];
        if (!view) continue;
        for (const e of view.edges) if (e.id) elementOf.set(e.id, e.relation);
        for (const b of view.boxes) if (b.kind === 'card') elementOf.set(b.id, b.element);
    }
    const elements = [...new Set((scope.elements ?? []).map(id => elementOf.get(id) ?? id))];
    // The instance check of all element terms in one query, not one read per data graph and term.
    const terms = elements.flatMap(id => { const t = relationTriple(id); return (t ? [t.s, t.o] : [elementTerm(id)]).flatMap(x => x?.termType === 'NamedNode' ? [x.value] : []); });
    const instances = new Set<string>(instancesAmong(g, terms));
    const own = [...instances];
    if (scope.neighbors && own.length) for (const x of neighbors(g, own)) instances.add(x);
    if (instances.size && (scope.neighbors || [...instances].some(s => !doc.instances[elementId(rdf.namedNode(s))]))) records(g, doc, [...instances]);

    if (scope.showing) for (const v of viewsPlacing(g, showingTerms(doc, elements, own))) readPart(v, elements);
    return doc;
}

/** The instances with a statement to or from one of `subjects` (model graph and shapes graphs). */
export function neighbors(g: ModelGraph, subjects: string[]): string[] {
    const graphs = [...g.dataGraphs(), ...g.shapesGraphs()].map(t => iri(t.value)).join(', ');
    const found = select(g, `${PREFIXES} SELECT DISTINCT ?x WHERE {
        VALUES ?s { ${subjects.map(iri).join(' ')} }
        { GRAPH ?g { ?s ?p ?x } } UNION { GRAPH ?g { ?x ?p ?s } }
        FILTER (isIRI(?x) && ?g IN (${graphs}) && ?p NOT IN (rdf:type, rdfs:label)) }`);
    const instances = instancesAmong(g, found.map(r => r.x.value));
    return found.map(r => r.x.value).filter(x => instances.has(x));
}

/**
 * Instance records of `iris` (each an instance of the store) and the relations between them, into `doc`. The statements of an
 * instance of the model graph are its model graph statements; of a SKOS subject of a shapes file, its statements of that graph.
 */
function records(g: ModelGraph, doc: Doc, iris: string[]): void {
    const statements = new Map<string, Statements>();
    for (const r of select(g, `SELECT ?s ?p ?o WHERE { VALUES ?s { ${iris.map(iri).join(' ')} } GRAPH ${iri(g.union.value)} { ?s ?p ?o } }`)) {
        let e = statements.get(key(r.s));
        if (!e) statements.set(key(r.s), e = { s: r.s, rows: [] });
        e.rows.push(r);
    }
    const files = new Map<string, string>();
    const subjects: Statements[] = [];
    const inModel = inModelAmong(g, iris);
    for (const s of iris) {
        const t = rdf.namedNode(s);
        const home = inModel.has(s) ? g.union : homeOf(g, t);
        if (home.equals(g.union)) {
            const e = statements.get('NamedNode ' + s);
            if (e) subjects.push(e);
            continue;
        }
        files.set(s, fileOfGraph(home.value));
        const rows = g.match(t, null, null, home).map(q => ({ s: plain(q.subject), p: plain(q.predicate), o: plain(q.object) }));
        if (rows.length) subjects.push({ s: rows[0].s, rows });
    }
    const part = emptyDoc();
    instanceRecords(part, subjects, files, []);
    Object.assign(doc.instances, part.instances);
    Object.assign(doc.relations, part.relations);
}

/** The terms whose placement makes a view show one of `elements` (see DocScope.showing). `instances`: the instances among them. */
function showingTerms(doc: Doc, elements: string[], instances: string[]): string[] {
    const { nodeShapes, properties, constraints, valueSets } = doc.shapes;
    const terms = new Set<string>(instances);
    for (const id of elements) {
        const owner = properties[id]?.owner ?? constraints[id]?.owner ?? id;
        const shape = nodeShapes[owner]?.uri ?? valueSets[id]?.uri;
        if (shape) terms.add(shape);
        if (doc.views[id]) terms.add(doc.views[id].uri);
    }
    for (const s of Object.values(valueSets)) if (s.members.some(m => instances.includes(m.uri))) terms.add(s.uri);
    return [...terms];
}

/** The views (ids) with a placement of one of `terms`. */
function viewsPlacing(g: ModelGraph, terms: string[]): string[] {
    if (!terms.length) return [];
    return select(g, `${PREFIXES} SELECT DISTINCT ?g WHERE { VALUES ?e { ${terms.map(iri).join(' ')} } GRAPH ?g { ?n a view:Placement ; view:element ?e } }`)
        .filter(r => r.g.termType === 'NamedNode' && isView(g, r.g.term)).map(r => elementId(r.g.term as NamedNode)).sort(cmp);
}

/** The number of instances of the store: IRIs of the model graph with a type or a label, and the SKOS subjects of the shapes files. */
export function instanceCount(g: ModelGraph): number {
    const model = select(g, `${PREFIXES} SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { GRAPH ${iri(g.union.value)} { ?s rdf:type|rdfs:label ?o }
        FILTER (isIRI(?s) && ?s != ${iri(UNION_GRAPH)} && ?s != ${iri(g.union.value)}) }`)[0];
    return Number(model?.n.value ?? 0) + vocabularySubjects(g).size;
}

/** The label of each instance (rdfs:label, else skos:prefLabel, else from the IRI; the first literal in order), as `instanceRecords` gives it. */
export function instanceLabels(g: ModelGraph): Map<string, string> {
    const out = new Map<string, { label?: string; pref?: string }>();
    for (const r of select(g, `${PREFIXES} SELECT ?s ?p ?l WHERE {
        { GRAPH ${iri(g.union.value)} { ?s rdf:type|rdfs:label ?any } FILTER (isIRI(?s) && ?s != ${iri(UNION_GRAPH)} && ?s != ${iri(g.union.value)}) }
        OPTIONAL { GRAPH ${iri(g.union.value)} { ?s ?p ?l } FILTER (?p IN (rdfs:label, <${NS.skos}prefLabel>) && isLiteral(?l)) } }`)) {
        const e = out.get(r.s.value) ?? out.set(r.s.value, {}).get(r.s.value)!;
        if (!r.l) continue;
        if (r.p.value === P.label.value) { if (e.label === undefined || cmp(r.l.value, e.label) < 0) e.label = r.l.value; }
        else if (e.pref === undefined || cmp(r.l.value, e.pref) < 0) e.pref = r.l.value;
    }
    const labels = new Map([...out].map(([s, e]) => [s, e.label ?? e.pref ?? labelFromIri(s)]));
    for (const [s, graph] of vocabularySubjects(g)) {
        const t = rdf.namedNode(s);
        const literals = (p: string) => g.match(t, rdf.namedNode(p), null, graph).filter(q => q.object.termType === 'Literal').map(q => q.object.value).sort(cmp);
        labels.set(s, literals(P.label.value)[0] ?? literals(NS.skos + 'prefLabel')[0] ?? labelFromIri(s));
    }
    return labels;
}

/** File references of all views: the view graph IRI and the stored path (view:file) of each. */
export function fileReferences(g: ModelGraph): { view: string; file: string }[] {
    return select(g, `${PREFIXES} SELECT DISTINCT ?g ?file WHERE { GRAPH ?g { ?n a view:Placement ; view:element ?m } GRAPH ?mg { ?m a view:FileRef ; view:file ?file } }`)
        .filter(r => r.g.termType === 'NamedNode' && r.g.value !== REPORT_GRAPH).map(r => ({ view: r.g.value, file: r.file.value }));
}

const values = (iris: Iterable<string>) => [...iris].map(iri).join(' ');

/** Subject → its warning: the subjects of the model graph with more than one rdfs:label (of `subjects`; none: all). */
function labelWarnings(g: ModelGraph, subjects?: readonly string[]): Map<string, string> {
    const M = iri(g.union.value), out = new Map<string, string>();
    const found = select(g, `${PREFIXES} SELECT ?s (COUNT(?l) AS ?n) WHERE { ${subjects ? `VALUES ?s { ${values(subjects)} }` : ''}
        GRAPH ${M} { ?s rdfs:label ?l } FILTER (isIRI(?s) && ?s != ${iri(UNION_GRAPH)}) } GROUP BY ?s HAVING (COUNT(?l) > 1)`).map(r => r.s.value);
    if (!found.length) return out;
    // The label that the card shows (instanceLabels): the first literal rdfs:label in order (a subject of the model graph is no vocabulary subject).
    const first = new Map<string, string>();
    for (const r of select(g, `${PREFIXES} SELECT ?s ?l WHERE { VALUES ?s { ${values(found)} } GRAPH ${M} { ?s rdfs:label ?l } FILTER (isLiteral(?l)) }`)) {
        const was = first.get(r.s.value);
        if (was === undefined || cmp(r.l.value, was) < 0) first.set(r.s.value, r.l.value);
    }
    const pref = new Map<string, string>();
    for (const r of select(g, `${PREFIXES} SELECT ?s ?l WHERE { VALUES ?s { ${values(found.filter(x => !first.has(x)))} } GRAPH ${M} { ?s <${NS.skos}prefLabel> ?l } FILTER (isLiteral(?l)) }`)) {
        const was = pref.get(r.s.value);
        if (was === undefined || cmp(r.l.value, was) < 0) pref.set(r.s.value, r.l.value);
    }
    for (const x of found) out.set(x, `${x}: more than one rdfs:label, shows "${first.get(x) ?? pref.get(x) ?? labelFromIri(x)}"`);
    return out;
}

/** Subject → its warning: the subjects of the model graph without rdf:type or rdfs:label (of `subjects`; none: all). */
function untypedWarnings(g: ModelGraph, subjects?: readonly string[]): Map<string, string> {
    const M = iri(g.union.value);
    return new Map(select(g, `${PREFIXES} SELECT DISTINCT ?s WHERE { ${subjects ? `VALUES ?s { ${values(subjects)} }` : ''} GRAPH ${M} { ?s ?p ?o }
        FILTER (?s != ${iri(UNION_GRAPH)} && (!isIRI(?s) || NOT EXISTS { GRAPH ${M} { ?s rdf:type|rdfs:label ?any } })) }`)
        .map(r => [r.s.value, `subject without rdf:type or rdfs:label kept in the file, not shown: ${r.s.value}`]));
}

/** Statements about the model graph (other than dct:conformsTo). */
function modelGraphWarnings(g: ModelGraph): string[] {
    return select(g, `SELECT ?p WHERE { GRAPH ${iri(g.union.value)} { ${iri(UNION_GRAPH)} ?p ?o } }`)
        .filter(r => r.p.value !== P.conformsTo.value).map(r => `statement about the model graph kept in the file, not shown: ${r.p.value}`);
}

/** Graphs without a role and without a view:View. */
function graphWarnings(g: ModelGraph): string[] {
    const excluded = [...g.dataGraphs(), ...g.shapesGraphs(), rdf.namedNode(REPORT_GRAPH)].map(t => iri(t.value)).join(', ');
    return select(g, `${PREFIXES} SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER (isIRI(?g) && ?g NOT IN (${excluded}))
        FILTER NOT EXISTS { GRAPH ?g { ?v a view:View } } }`).sort((a, b) => cmp(a.g.value, b.g.value))
        .map(r => `graph ${r.g.value} has no view:View, kept in the file, not shown`);
}

/** The warnings of the read of one view, and the terms whose statements the read depends on (DatasetWarnings). */
interface ViewWarnings { warnings: string[]; terms: Set<string> }

function viewWarnings(g: ModelGraph, view: NamedNode, shapes: ShapesModel): ViewWarnings {
    const all: string[] = [];
    readView(g, elementId(view), shapes, all);
    // The several labels of a subject of the model graph are a subject warning (labelWarnings), kept by subject: the copy of the view
    // read would stay when a rename changes the labels and the view is not read again.
    const several = new Map(all.flatMap(w => { const m = /^(\S+): more than one rdfs:label, /.exec(w); return m ? [[w, m[1]] as const] : []; }));
    const inModel = several.size ? inModelAmong(g, [...new Set(several.values())]) : new Set<string>();
    const warnings = all.filter(w => !inModel.has(several.get(w) ?? ''));
    // What the projection of the view reads besides its view graph: the placed elements (cards, marks, referenced views), the ends of
    // the placed statements (relations, arrows), and the members of the placed collections.
    const terms = new Set(select(g, `${PREFIXES} SELECT DISTINCT ?e WHERE {
        { GRAPH ${iri(view.value)} { ?pl view:element ?e } }
        UNION { GRAPH ${iri(view.value)} { ?pl rdf:reifies ?t } BIND (SUBJECT(?t) AS ?e) }
        UNION { GRAPH ${iri(view.value)} { ?pl rdf:reifies ?t } BIND (OBJECT(?t) AS ?e) }
        UNION { GRAPH ${iri(view.value)} { ?pl view:element ?c } GRAPH ?mg { ?c view:member ?e } }
        FILTER (isIRI(?e)) }`).map(r => r.e.value));
    return { warnings, terms };
}

const assemble = (labels: Map<string, string>, model: string[], untyped: Map<string, string>, graphs: string[], views: Iterable<ViewWarnings>) => [...new Set([
    ...[...labels].sort((a, b) => cmp(a[0], b[0])).map(([, w]) => w), ...model, ...[...untyped].sort((a, b) => cmp(a[0], b[0])).map(([, w]) => w),
    ...graphs, ...[...views].flatMap(v => v.warnings)
])];

/**
 * What the read models cannot show in the current dataset: statements about the model graph, subjects without a type or a label,
 * instances with several labels, graphs without a view, and the parts of each view (view-read.ts). The statements stay in the files.
 */
export function readWarnings(g: ModelGraph, shapes: ShapesModel): string[] {
    return assemble(labelWarnings(g), modelGraphWarnings(g), untypedWarnings(g), graphWarnings(g), viewGraphs(g).map(v => viewWarnings(g, v, shapes)));
}

/** A patch of more quads than this (a load, a file read) reads all warnings again. */
const WARNINGS_PATCH_LIMIT = 2000;
const VIEW_TYPE = NS.view + 'View';
/** The predicates of the marks that a view projects (view-read.ts MARKS) and of the arrows. */
const MARK_PREDICATES = new Set([P.type.value, P.label.value, ...['text', 'file', 'member', 'arrow'].map(p => NS.view + p)]);

/**
 * The dataset warnings (readWarnings), kept between changes of one graph (spec/manifest.hs §11.3 law_keptReadsEqualRead). A data
 * patch reads again the subject warnings of its subjects only, and the views whose read it can change: a changed view graph, a view
 * that places a changed term of a statement to an IRI, of a view:* statement, or of a statement of a term that is not an instance (or
 * stops or starts being one). A shapes change, a patch without quads or a large patch reads all again.
 */
export class DatasetWarnings {
    protected graph?: ModelGraph;
    protected shapes?: ShapesModel;
    protected kept?: { labels: Map<string, string>; model: string[]; untyped: Map<string, string>; graphs: string[]; views: Map<string, ViewWarnings>; out: string[] };
    /** The changes since the last read; undefined: read all. */
    protected pending?: { op: 'add' | 'remove'; quad: Quad }[];

    read(g: ModelGraph, shapes: ShapesModel): string[] {
        if (g !== this.graph) {
            this.graph = g;
            this.kept = undefined;
            g.onDidChange(e => {
                if (g !== this.graph || (!e.data && !e.shapes)) return;
                if (e.shapes || !e.patch.length || !this.pending || this.pending.length + e.patch.length > WARNINGS_PATCH_LIMIT) this.pending = undefined;
                else this.pending.push(...e.patch);
            });
        }
        if (!this.kept || !this.pending || shapes !== this.shapes) return this.readAll(g, shapes);
        if (this.pending.length) this.update(g, shapes, this.pending);
        this.pending = [];
        return this.kept.out;
    }

    protected readAll(g: ModelGraph, shapes: ShapesModel): string[] {
        this.shapes = shapes;
        this.pending = [];
        const views = new Map(viewGraphs(g).map(v => [v.value, viewWarnings(g, v, shapes)]));
        const kept = { labels: labelWarnings(g), model: modelGraphWarnings(g), untyped: untypedWarnings(g), graphs: graphWarnings(g), views, out: [] as string[] };
        kept.out = assemble(kept.labels, kept.model, kept.untyped, kept.graphs, views.values());
        this.kept = kept;
        return kept.out;
    }

    protected update(g: ModelGraph, shapes: ShapesModel, changes: readonly { op: 'add' | 'remove'; quad: Quad }[]): void {
        const kept = this.kept!;
        const data = changes.filter(c => g.isDataGraph(c.quad.graph));
        const subjects = [...new Set(data.flatMap(c => c.quad.subject.termType === 'NamedNode' ? [c.quad.subject.value] : []))];
        if (subjects.length) {
            for (const s of subjects) { kept.labels.delete(s); kept.untyped.delete(s); }
            for (const [s, w] of labelWarnings(g, subjects)) kept.labels.set(s, w);
            for (const [s, w] of untypedWarnings(g, subjects)) kept.untyped.set(s, w);
        }
        if (subjects.includes(UNION_GRAPH)) kept.model = modelGraphWarnings(g);
        const other = changes.filter(c => !g.isDataGraph(c.quad.graph) && !g.isShapesGraph(c.quad.graph) && c.quad.graph.value !== REPORT_GRAPH);
        if (other.some(c => !isView(g, c.quad.graph) || (c.quad.predicate.value === P.type.value && c.quad.object.value === VIEW_TYPE))) kept.graphs = graphWarnings(g);
        // The terms whose change can change the read of a view that places them.
        const relevant = new Set<string>();
        const literal = data.filter(c => c.quad.object.termType !== 'NamedNode').map(c => c.quad.subject.value);
        const instances = literal.length ? instancesAmong(g, literal) : new Set<string>();
        const typing = (c: { quad: Quad }) => c.quad.predicate.value === P.type.value || c.quad.predicate.value === P.label.value;
        // An instance stays one when it had a type or a label that the patch removed, or when the patch added none.
        const stays = (s: string) => instances.has(s) && (data.some(c => c.op === 'remove' && typing(c) && c.quad.subject.value === s)
            || !data.some(c => c.op === 'add' && typing(c) && c.quad.subject.value === s));
        for (const { quad: q } of data) {
            if (q.object.termType === 'NamedNode') { relevant.add(q.subject.value); relevant.add(q.object.value); }
            else if (q.predicate.value.startsWith(NS.view) || !stays(q.subject.value)) relevant.add(q.subject.value);
        }
        const changedViews = new Set<string>();
        for (const { quad: q } of other) {
            changedViews.add(q.graph.value);
            relevant.add(q.graph.value);
            if (MARK_PREDICATES.has(q.predicate.value)) {
                relevant.add(q.subject.value);
                if (q.object.termType === 'NamedNode') relevant.add(q.object.value);
            }
        }
        const views = new Map<string, ViewWarnings>();
        for (const v of viewGraphs(g)) {
            const was = kept.views.get(v.value);
            views.set(v.value, !was || changedViews.has(v.value) || [...relevant].some(t => was.terms.has(t)) ? viewWarnings(g, v, shapes) : was);
        }
        kept.views = views;
        kept.out = assemble(kept.labels, kept.model, kept.untyped, kept.graphs, views.values());
    }
}

/** A row of the card halo: related instances in and out that the view does not show, and shapes or targets that it does not show. */
export type NeighborCount = { in: number; out: number; targets?: number };

/**
 * The counts of `hiddenNeighborCounts` after a data patch, from the counts before it (`prior`) and the IRIs of the changed statements
 * (§11.3 DataPatch, law_keptReadsEqualRead). The related instances of a card change when its statements change, or when a
 * related node stops or starts being an instance: only the related instances of these cards are read again. The target counts come
 * from the kept matches of each node (shacl-targets.ts) for all cards. The view itself did not change.
 */
export function updateHiddenNeighborCounts(g: ModelGraph, shapes: ShapesModel, view: View, prior: ReadonlyMap<string, NeighborCount>, changed: readonly string[]): Map<string, NeighborCount> {
    const cards = new Set<string>();
    for (const b of boxes(view, 'card')) { const t = elementTerm(b.element); if (t?.termType === 'NamedNode') cards.add(t.value); }
    const affected = new Set(changed.filter(x => cards.has(x)));
    const iris = changed.filter(x => IRI_TEXT.test(x));
    if (iris.length) {
        const graphs = [...g.dataGraphs(), ...g.shapesGraphs()].map(t => iri(t.value)).join(', ');
        for (const r of select(g, `${PREFIXES} SELECT DISTINCT ?c WHERE { VALUES ?e { ${values(iris)} }
            { GRAPH ?g { ?e ?p ?c } } UNION { GRAPH ?g { ?c ?p ?e } } FILTER (isIRI(?c) && ?g IN (${graphs})) }`)) if (cards.has(r.c.value)) affected.add(r.c.value);
    }
    return hiddenNeighborCounts(g, shapes, view, { rows: prior, affected });
}

const IRI_TEXT = /^[^\s<>"{}|^`\\]+$/;

/**
 * For each instance card of `view`: the number of instances related to it ('in': subjects of its relations, 'out': objects) that the
 * view does not show. The rule of `hiddenNeighborCounts` (@catenary/model) on SPARQL rows of the cards, without the records of all instances.
 * `prior`: the related instances of the cards outside `affected` (IRIs) come from these rows; only the affected cards are read.
 */
export function hiddenNeighborCounts(g: ModelGraph, shapes: ShapesModel, view: View, prior?: { rows: ReadonlyMap<string, NeighborCount>; affected: ReadonlySet<string> }): Map<string, NeighborCount> {
    // The instance test of all cards in one request (§11.3 readBudgetMs), not one store read per card.
    const cardTerms = boxes(view, 'card').flatMap(b => { const t = elementTerm(b.element); return t?.termType === 'NamedNode' ? [{ b, t }] : []; });
    const cardInstances = instancesAmong(g, cardTerms.map(c => c.t.value));
    const cards = new Map<string, string>();
    for (const { b, t } of cardTerms) if (cardInstances.has(t.value)) cards.set(t.value, b.element);
    const out = new Map<string, NeighborCount>();
    const placed = new Set(boxes(view, 'card').map(b => b.element));
    // The IRIs of the cards once: a test by IRI, not an id built for each target.
    const placedIris = new Set(cardTerms.map(c => c.t.value));
    // One request for all shape cards, not one per card.
    const placedShapes = Object.values(shapes.nodeShapes).filter(s => placed.has(s.id));
    const targets = placedShapes.length ? shapeTargetMatches(g, { shapes: placedShapes.map(s => s.uri) }).filter(m => m.node.termType === 'NamedNode' && !placedIris.has(m.node.value)) : [];
    const targetInstances = instancesAmong(g, targets.map(m => m.node.value));
    const hidden = targets.filter(m => targetInstances.has(m.node.value));
    const hiddenOf = new Map<string, number>();
    for (const m of hidden) hiddenOf.set(m.shape, (hiddenOf.get(m.shape) ?? 0) + 1);
    for (const shape of placedShapes) {
        const targets = hiddenOf.get(shape.uri) ?? 0;
        if (targets) out.set(shape.id, { in: 0, out: 0, targets });
    }
    if (!cards.size) return out;
    // The IRIs that the view shows, once: a card, or a member of a shown value set (not a test per neighbor over all boxes).
    const shownIris = new Set<string>(placedIris);
    for (const b of boxes(view, 'card')) for (const m of shapes.valueSets[b.element]?.members ?? []) shownIris.add(m.uri);
    const shown = (iri: string) => cards.has(iri) || shownIris.has(iri);
    const graphs = [...g.dataGraphs(), ...g.shapesGraphs()].map(t => iri(t.value)).join(', ');
    const read = [...cards.keys()].filter(c => !prior || prior.affected.has(c));
    const counts = new Map<string, { in: number; out: number }>();
    // The cards that are not read again keep the related instances of their prior row (a row without any has 0 in and 0 out).
    if (prior) for (const [c, id] of cards) {
        const row = prior.rows.get(id);
        if (!prior.affected.has(c) && row && (row.in || row.out)) counts.set(c, { in: row.in, out: row.out });
    }
    const others = new Map<string, { in: Set<string>; out: Set<string> }>();
    const found = read.length ? select(g, `${PREFIXES} SELECT DISTINCT ?s ?x ?g ?dir WHERE { VALUES ?s { ${values(read)} }
        { GRAPH ?g { ?s ?p ?x } BIND ("out" AS ?dir) } UNION { GRAPH ?g { ?x ?p ?s } BIND ("in" AS ?dir) }
        FILTER (isIRI(?x) && ?g IN (${graphs}) && ?p NOT IN (rdf:type, rdfs:label)) }`) : [];
    // The homes and the instance test of all neighbors in one request each, not one store read per row.
    const homes = homesAmong(g, found.flatMap(r => [r.s.value, r.x.value]));
    const neighborInstances = instancesAmong(g, found.map(r => r.x.value));
    const add = (self: string, dir: 'in' | 'out', other: string) => {
        if (other === self || !neighborInstances.has(other) || shown(other)) return;
        const o = others.get(self) ?? others.set(self, { in: new Set(), out: new Set() }).get(self)!;
        o[dir].add(other);
    };
    for (const r of found) {
        const dir = r.dir.value as 'in' | 'out';
        // A relation is a statement of the graph of its subject (the model graph, or the shapes graph of a SKOS subject).
        const owner = homes.get(dir === 'out' ? r.s.value : r.x.value);
        if (owner === g.union.value ? !g.isDataGraph(r.g) : r.g.value !== owner) continue;
        add(r.s.value, dir, r.x.value);
    }
    for (const [self, o] of others) counts.set(self, { in: o.in.size, out: o.out.size });
    // In the order of the cards, as a read of all cards gives them.
    for (const [self, id] of cards) { const c = counts.get(self); if (c) out.set(id, { in: c.in, out: c.out }); }
    const shownShapes = new Set(boxes(view, 'card').map(c => c.element));
    const shapeIds = new Map(Object.values(shapes.nodeShapes).map(s => [s.uri, s.id]));
    // The shapes of each card that the view does not show, from the kept matches of each node (shacl-targets.ts).
    const unshown = new Map<string, number>();
    for (const m of shapeTargetMatches(g, { nodes: [...cards.keys()].map(value => ({ termType: 'NamedNode', value })) })) {
        if (shapeIds.has(m.shape) && !shownShapes.has(shapeIds.get(m.shape)!)) unshown.set(m.node.value, (unshown.get(m.node.value) ?? 0) + 1);
    }
    for (const [uri, id] of cards) {
        const targets = unshown.get(uri) ?? 0;
        const row = out.get(id);
        if (targets && row) row.targets = targets;
        else if (targets) out.set(id, { in: 0, out: 0, targets });
    }
    return out;
}
