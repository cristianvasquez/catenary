// Request-scoped read models (ADR 0012): a Doc with only the elements, neighbors and views that one request needs, from SPARQL rows.
// The store builds one for each request and keeps none. The records use the rules of project.ts (`instanceRecords`) and view-read.ts.
// Every view has an entry: the views that the scope does not read have their label only (no boxes, edges or arrows).

import type { NamedNode, Term } from '@rdfjs/types';
import { Doc, NS, ShapesModel, View, boxes, elementOfId, emptyDoc } from '@catenary/model';
import { MODEL_GRAPH, ModelGraph, P, VALIDATION_GRAPH, fileOfGraph, labelFromIri, cmp } from './graph';
import { elementId, elementTerm, relationTriple } from './ids';
import { Plain, Statements, instanceRecords, key, select } from './records';
import { rdf } from './terms';
import { ViewReadContext, readView, viewLabels } from './view-read';

export interface DocScope {
    /** Element ids: instances, relations, views and shape elements. A placement id of one of `views` stands for its element. */
    elements?: string[];
    /** Also the instances related to the instances of `elements`, with the relations to them. */
    neighbors?: boolean;
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
    const readFull = (viewId: string) => {
        if (read.has(viewId) || !doc.views[viewId]) return;
        read.add(viewId);
        const part = readView(g, viewId, shapes);
        if (part.views[viewId]) doc.views[viewId] = part.views[viewId];
        for (const [id, i] of Object.entries(part.instances)) doc.instances[id] ??= i;
        for (const [id, r] of Object.entries(part.relations)) doc.relations[id] ??= r;
    };
    const views = (scope.views ?? []).filter((v): v is string => !!v);
    views.forEach(readFull);

    // Elements: a placement id of a read view stands for its element.
    const elements = [...new Set((scope.elements ?? []).map(id => {
        for (const v of views) {
            const e = elementOfId(doc.views[v], id);
            if (e !== id) return e;
        }
        return id;
    }))];
    const instances = new Set<string>();
    for (const id of elements) {
        const t = relationTriple(id);
        for (const x of t ? [t.s, t.o] : [elementTerm(id)]) if (x?.termType === 'NamedNode' && g.isInstance(x)) instances.add(x.value);
    }
    const own = [...instances];
    if (scope.neighbors && own.length) for (const x of neighbors(g, own)) instances.add(x);
    if (instances.size) records(g, doc, [...instances]);

    if (scope.showing) for (const v of viewsPlacing(g, showingTerms(doc, elements, own))) readFull(v);
    return doc;
}

/** The instances with a statement to or from one of `subjects` (model graph and shapes graphs). */
export function neighbors(g: ModelGraph, subjects: string[]): string[] {
    const graphs = [g.model, ...g.shapesGraphs()].map(t => iri(t.value)).join(', ');
    const found = select(g, `${PREFIXES} SELECT DISTINCT ?x WHERE {
        VALUES ?s { ${subjects.map(iri).join(' ')} }
        { GRAPH ?g { ?s ?p ?x } } UNION { GRAPH ?g { ?x ?p ?s } }
        FILTER (isIRI(?x) && ?g IN (${graphs}) && ?p NOT IN (rdf:type, rdfs:label)) }`);
    return found.map(r => r.x.value).filter(x => g.isInstance(rdf.namedNode(x)));
}

/**
 * Instance records of `iris` (each an instance of the store) and the relations between them, into `doc`. The statements of an
 * instance of the model graph are its model graph statements; of a SKOS subject of a shapes file, its statements of that graph.
 */
function records(g: ModelGraph, doc: Doc, iris: string[]): void {
    const statements = new Map<string, Statements>();
    for (const r of select(g, `SELECT ?s ?p ?o WHERE { VALUES ?s { ${iris.map(iri).join(' ')} } GRAPH ${iri(g.model.value)} { ?s ?p ?o } }`)) {
        let e = statements.get(key(r.s));
        if (!e) statements.set(key(r.s), e = { s: r.s, rows: [] });
        e.rows.push(r);
    }
    const files = new Map<string, string>();
    const subjects: Statements[] = [];
    for (const s of iris) {
        const t = rdf.namedNode(s);
        const home = g.homeOf(t);
        if (home.equals(g.model)) {
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
        .filter(r => r.g.termType === 'NamedNode' && g.isView(r.g.term)).map(r => elementId(r.g.term as NamedNode)).sort(cmp);
}

/** The number of instances of the store: IRIs of the model graph with a type or a label, and the SKOS subjects of the shapes files. */
export function instanceCount(g: ModelGraph): number {
    const model = select(g, `${PREFIXES} SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { GRAPH ${iri(g.model.value)} { ?s rdf:type|rdfs:label ?o }
        FILTER (isIRI(?s) && ?s != ${iri(MODEL_GRAPH)} && ?s != ${iri(g.model.value)}) }`)[0];
    return Number(model?.n.value ?? 0) + g.vocabularySubjects().size;
}

/** The label of each instance (rdfs:label, else skos:prefLabel, else from the IRI; the first literal in order), as `instanceRecords` gives it. */
export function instanceLabels(g: ModelGraph): Map<string, string> {
    const out = new Map<string, { label?: string; pref?: string }>();
    for (const r of select(g, `${PREFIXES} SELECT ?s ?p ?l WHERE {
        { GRAPH ${iri(g.model.value)} { ?s rdf:type|rdfs:label ?any } FILTER (isIRI(?s) && ?s != ${iri(MODEL_GRAPH)} && ?s != ${iri(g.model.value)}) }
        OPTIONAL { GRAPH ${iri(g.model.value)} { ?s ?p ?l } FILTER (?p IN (rdfs:label, <${NS.skos}prefLabel>) && isLiteral(?l)) } }`)) {
        const e = out.get(r.s.value) ?? out.set(r.s.value, {}).get(r.s.value)!;
        if (!r.l) continue;
        if (r.p.value === P.label.value) { if (e.label === undefined || cmp(r.l.value, e.label) < 0) e.label = r.l.value; }
        else if (e.pref === undefined || cmp(r.l.value, e.pref) < 0) e.pref = r.l.value;
    }
    const labels = new Map([...out].map(([s, e]) => [s, e.label ?? e.pref ?? labelFromIri(s)]));
    for (const [s, graph] of g.vocabularySubjects()) {
        const t = rdf.namedNode(s);
        const literals = (p: string) => g.match(t, rdf.namedNode(p), null, graph).filter(q => q.object.termType === 'Literal').map(q => q.object.value).sort(cmp);
        labels.set(s, literals(P.label.value)[0] ?? literals(NS.skos + 'prefLabel')[0] ?? labelFromIri(s));
    }
    return labels;
}

/** File references of all views: the view graph IRI and the stored path (view:file) of each. */
export function fileReferences(g: ModelGraph): { view: string; file: string }[] {
    return select(g, `${PREFIXES} SELECT DISTINCT ?g ?file WHERE { GRAPH ?g { ?n a view:Placement ; view:element ?m } GRAPH ?mg { ?m a view:FileRef ; view:file ?file } }`)
        .filter(r => r.g.termType === 'NamedNode' && r.g.value !== VALIDATION_GRAPH).map(r => ({ view: r.g.value, file: r.file.value }));
}

/**
 * What the read models cannot show, at the open of a workspace: statements about the model graph, subjects without a type or a label,
 * instances with several labels, graphs without a view, and the parts of each view (view-read.ts). The statements stay in the files.
 */
export function readWarnings(g: ModelGraph, shapes: ShapesModel): string[] {
    const warnings: string[] = [];
    const M = iri(g.model.value);
    const labels = instanceLabels(g);
    for (const r of select(g, `${PREFIXES} SELECT ?s (COUNT(?l) AS ?n) WHERE { GRAPH ${M} { ?s rdfs:label ?l } FILTER (isIRI(?s) && ?s != ${iri(MODEL_GRAPH)}) } GROUP BY ?s HAVING (COUNT(?l) > 1)`)
        .sort((a, b) => cmp(a.s.value, b.s.value))) {
        warnings.push(`${r.s.value}: more than one rdfs:label, shows "${labels.get(r.s.value)}"`);
    }
    for (const r of select(g, `SELECT ?p WHERE { GRAPH ${M} { ${iri(MODEL_GRAPH)} ?p ?o } }`)) {
        if (r.p.value !== P.conformsTo.value) warnings.push(`statement about the model graph kept in the file, not shown: ${r.p.value}`);
    }
    for (const r of select(g, `${PREFIXES} SELECT DISTINCT ?s WHERE { GRAPH ${M} { ?s ?p ?o }
        FILTER (?s != ${iri(MODEL_GRAPH)} && (!isIRI(?s) || NOT EXISTS { GRAPH ${M} { ?s rdf:type|rdfs:label ?any } })) }`)) {
        warnings.push(`subject without rdf:type or rdfs:label kept in the file, not shown: ${r.s.value}`);
    }
    const excluded = [g.model, ...g.shapesGraphs(), rdf.namedNode(VALIDATION_GRAPH)].map(t => iri(t.value)).join(', ');
    for (const r of select(g, `${PREFIXES} SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER (isIRI(?g) && ?g NOT IN (${excluded}))
        FILTER NOT EXISTS { GRAPH ?g { ?v a view:View } } }`).sort((a, b) => cmp(a.g.value, b.g.value))) {
        warnings.push(`graph ${r.g.value} has no view:View, kept in the file, not shown`);
    }
    for (const v of g.views()) readView(g, elementId(v), shapes, warnings);
    return [...new Set(warnings)];
}

/**
 * For each instance card of `view`: the number of instances related to it ('in': subjects of its relations, 'out': objects) that the
 * view does not show. The rule of `hiddenNeighborCounts` (@catenary/model) on SPARQL rows of the cards, without the records of all instances.
 */
export function hiddenNeighborCounts(g: ModelGraph, shapes: ShapesModel, view: View): Map<string, { in: number; out: number; targets?: number }> {
    const cards = new Map<string, string>();
    for (const b of view.boxes) {
        if (b.kind !== 'card') continue;
        const t = elementTerm(b.element);
        if (t?.termType === 'NamedNode' && g.isInstance(t)) cards.set(t.value, b.element);
    }
    const out = new Map<string, { in: number; out: number; targets?: number }>();
    if (!cards.size) return out;
    const shownSets = Object.values(shapes.valueSets).filter(s => view.boxes.some(b => b.kind === 'card' && b.element === s.id));
    const shown = (iri: string) => cards.has(iri) || view.boxes.some(b => b.kind === 'card' && elementTerm(b.element)?.value === iri)
        || shownSets.some(s => s.members.some(m => m.uri === iri));
    const instance = new Map<string, boolean>(), home = new Map<string, string>();
    const isInstance = (iri: string) => instance.get(iri) ?? instance.set(iri, g.isInstance(rdf.namedNode(iri))).get(iri)!;
    const homeOf = (iri: string) => home.get(iri) ?? home.set(iri, g.homeOf(rdf.namedNode(iri)).value).get(iri)!;
    const graphs = [g.model, ...g.shapesGraphs()].map(t => iri(t.value)).join(', ');
    const values = [...cards.keys()].map(iri).join(' ');
    const others = new Map<string, { in: Set<string>; out: Set<string> }>();
    const add = (self: string, dir: 'in' | 'out', other: string) => {
        if (other === self || !isInstance(other) || shown(other)) return;
        const o = others.get(self) ?? others.set(self, { in: new Set(), out: new Set() }).get(self)!;
        o[dir].add(other);
    };
    for (const r of select(g, `${PREFIXES} SELECT DISTINCT ?s ?x ?g ?dir WHERE { VALUES ?s { ${values} }
        { GRAPH ?g { ?s ?p ?x } BIND ("out" AS ?dir) } UNION { GRAPH ?g { ?x ?p ?s } BIND ("in" AS ?dir) }
        FILTER (isIRI(?x) && ?g IN (${graphs}) && ?p NOT IN (rdf:type, rdfs:label)) }`)) {
        const dir = r.dir.value as 'in' | 'out';
        // A relation is a statement of the graph of its subject (the model graph, or the shapes graph of a SKOS subject).
        if (r.g.value !== homeOf(dir === 'out' ? r.s.value : r.x.value)) continue;
        add(r.s.value, dir, r.x.value);
    }
    for (const [self, o] of others) out.set(cards.get(self)!, { in: o.in.size, out: o.out.size });
    const shownShapes = new Set(boxes(view, 'card').map(c => c.element));
    for (const [uri, id] of cards) {
        const targets = Object.values(shapes.nodeShapes).filter(shape => !shownShapes.has(shape.id)
            && shape.targetSubjectsOf?.some(predicate => g.match(rdf.namedNode(uri), rdf.namedNode(predicate), null, rdf.namedNode(homeOf(uri))).length > 0)).length;
        const row = out.get(id);
        if (targets && row) row.targets = targets;
        else if (targets) out.set(id, { in: 0, out: 0, targets });
    }
    return out;
}
