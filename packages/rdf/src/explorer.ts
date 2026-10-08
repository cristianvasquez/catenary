// The Model explorer as SPARQL expansion rules (ADR 0006): the children of a node key are one query of the store with the parent
// bound. A query runs only when the frontend asks for the children of an open folder.

import type { NamedNode, Quad, Term } from '@rdfjs/types';
import {
    Classes, ConceptDef, ExplorerPath, ShapesModel, ExplorerRow, NS, VIEW_CLASS, classDef, classKey, conceptPath, conceptRoots, formatPath, rangeText,
    searchKind, valueSetOf, verbalizeProperty, fuzzyMatch
} from '@catenary/model';
import { ModelGraph, VALIDATION_GRAPH, labelFromIri } from './graph';
import { elementId, elementTerm, relationId, relationTriple } from './ids';
import { rdf, termKey } from './terms';
import { Vocabulary, connections, construct, labels, shapeTypes, thingTypes, vocabulary } from './sparql';

/** Element id -> ids of the views with a placement of it (a card: view:element; a relation: rdf:reifies of its triple). */
export type Placements = Map<string, Set<string>>;

export interface ExplorerContext {
    g: ModelGraph;
    /** The shapes model of the store (ShapesIndex.model). */
    shapes: ShapesModel;
    meta: Classes;
    /** Focus node IRI -> number of sh:Violation results in the report graph (query once per request). */
    problems?: Map<string, number>;
    placements: Placements;
    /** Property shape term (termKey) -> property shape id (ShapesIndex.byTerm). */
    byTerm: Map<string, string>;
    /** View id of the current view editor of the asking window. */
    currentView?: string;
    /** The file with most statements of a subject (the tooltip of an instance row). */
    fileOf?: (t: Term) => string | undefined;
    /** Reads that depend on the dataset only: the store keeps them until the dataset changes (not the violations, which change alone). */
    content: ExplorerContent;
}

/** The dataset reads of the explorer, filled on first use. Shape IDs still come from the shapes index. */
export interface ExplorerContent {
    types?: Quad[];
    connections?: Quad[];
    vocabulary?: Vocabulary;
}

const SKOS = NS.skos, SH = NS.sh;
const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX skos: <${SKOS}> PREFIX sh: <${SH}> PREFIX view: <${NS.view}>`;
const iri = (value: string) => `<${value}>`;

function select(g: ModelGraph, query: string): Record<string, Term>[] {
    return g.store.select(`${PREFIXES} ${query}`) as unknown as Record<string, Term>[];
}

/** The element id of a term: a property shape by the shapes index, else the IRI (ids.ts). */
function termId(ctx: ExplorerContext, t: Term): string {
    return ctx.byTerm.get(termKey(t as NamedNode)) ?? elementId(t as NamedNode);
}

/** The placements of all elements (views by element id). */
export function placements(g: ModelGraph, byTerm: Map<string, string>): Placements {
    const result: Placements = new Map();
    const add = (id: string, view: Term) => {
        let s = result.get(id);
        if (!s) result.set(id, s = new Set());
        s.add(elementId(view as NamedNode));
    };
    for (const r of select(g, 'SELECT ?v ?e WHERE { GRAPH ?v { ?pl view:element ?e } FILTER (isIRI(?e)) }')) {
        add(byTerm.get(termKey(r.e as NamedNode)) ?? elementId(r.e as NamedNode), r.v);
    }
    for (const r of select(g, `SELECT ?v ?s ?p ?o WHERE { GRAPH ?v { ?pl rdf:reifies ?t } FILTER (isTRIPLE(?t))
            BIND (SUBJECT(?t) AS ?s) BIND (PREDICATE(?t) AS ?p) BIND (OBJECT(?t) AS ?o) FILTER (isIRI(?s) && isIRI(?o)) }`)) {
        add(relationId(r.s as NamedNode, r.p as NamedNode, r.o as NamedNode), r.v);
    }
    return result;
}

/** Shared thing and shape type triples, read once per expansion request. */
function typeTriples(ctx: ExplorerContext): Quad[] {
    return ctx.content.types ??= [...rdf.dataset([...thingTypes(ctx.g), ...shapeTypes(ctx.g)])];
}

function typeMembers(ctx: ExplorerContext, cls: string): NamedNode[] {
    return typeTriples(ctx).filter(q => q.predicate.value === NS.rdf + 'type' && q.object.value === cls).map(q => q.subject as NamedNode);
}

/** Connection triples use the shared thing and predicate rules. */
function connectionTriples(ctx: ExplorerContext, predicate?: string): Quad[] {
    if (predicate) return construct(ctx.g, `CONSTRUCT { ?s ?p ?o } WHERE { ${connections()} FILTER (?p = ${iri(predicate)}) }`);
    return ctx.content.connections ??= construct(ctx.g, `CONSTRUCT { ?s ?p ?o } WHERE { ${connections()} }`);
}

/** The rows of a node key; undefined: the root. */
export function explorerChildren(ctx: ExplorerContext, key?: string): ExplorerRow[] {
    if (!key) return root(ctx);
    const [kind, ...rest] = key.split(':');
    const arg = rest.join(':');
    switch (kind) {
        case 'class': return classChildren(ctx, arg);
        case 'no-class': return noClass(ctx);
        case 'relations': return predicates(ctx);
        case 'rel': return relations(ctx, arg);
        case 'concepts': return concepts(ctx);
        case 'scheme': return schemeChildren(ctx, arg);
        case 'no-scheme': return noScheme(ctx);
        case 'collection': return collectionChildren(ctx, arg);
        case 'concept': return narrower(ctx, arg);
        case 'shape': return propertyRows(ctx, arg);
        default: return [];
    }
}

/** Filter full query branches, not loaded frontend nodes. Ancestors survive when a descendant matches. */
export function filteredExplorerChildren(ctx: ExplorerContext, key: string | undefined, includes: (id: string) => boolean, filter = ''): ExplorerRow[] {
    const visit = (key: string | undefined, path: Set<string>): { row: ExplorerRow; score: number }[] => {
        if (key && path.has(key)) return [];
        const next = new Set(path);
        if (key) next.add(key);
        return explorerChildren(ctx, key).flatMap(row => {
            const children = row.folder ? visit(row.key, next) : [];
            const own = !!row.element && includes(row.element);
            const match = fuzzyMatch(row.name, filter);
            // A grouping row stays only when an in-scope descendant matches.
            if (!(own && match) && !children.length) return [];
            const score = Math.max(own && match ? match.score : -Infinity, ...children.map(c => c.score));
            return [{ row: { ...row, ...(row.element && !own ? { element: undefined, card: undefined } : {}), ...(row.kind === 'folder' ? { badge: String(explorerElements(ctx, row.key).filter(includes).length) } : {}) }, score }];
        }).sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
    };
    return visit(key, new Set()).map(r => r.row);
}

/** Class folder names use the shared label rule. */
function classNames(ctx: ExplorerContext, classes: string[]): Map<string, string> {
    return labels(ctx.g, classes);
}

function classRow(ctx: ExplorerContext, cls: string, name: string, count: number, creatable: boolean): ExplorerRow {
    const def = classDef(ctx.meta, cls);
    return {
        key: classKey(cls), kind: 'folder', name, folder: true, badge: String(count), icon: 'symbol-class', color: def?.color,
        classIri: def || creatable || cls === VIEW_CLASS ? cls : undefined,
        tooltip: [cls, def?.description, `${count} members.`, def ? `Node shapes: ${def.shapes.join(', ')}` : ''].filter(Boolean).join('\n')
    };
}

function root(ctx: ExplorerContext): ExplorerRow[] {
    const counts = new Map<string, number>();
    for (const q of typeTriples(ctx)) if (q.predicate.value === NS.rdf + 'type') counts.set(q.object.value, (counts.get(q.object.value) ?? 0) + 1);
    const names = classNames(ctx, [...counts.keys()]);
    const rows = [...counts].map(([c, n]) => classRow(ctx, c, names.get(c)!, n, searchKind([c]) === 'instance'))
        .sort((a, b) => a.name.localeCompare(b.name));
    const relationCount = connectionTriples(ctx).length;
    rows.push({ key: 'relations', kind: 'folder', name: 'Relations', folder: true, badge: String(relationCount), icon: 'references' });
    if (['Concept', 'ConceptScheme', 'Collection'].some(t => counts.has(NS.skos + t))) {
        rows.push({ key: 'concepts', kind: 'folder', name: 'Concepts', folder: true, badge: String(counts.get(NS.skos + 'Concept') ?? 0), icon: 'symbol-enum' });
    }
    return rows;
}

/** The view id of a graph, if it is a view graph. */
function viewOf(ctx: ExplorerContext, graph: Term | undefined): string | undefined {
    if (!graph || graph.termType !== 'NamedNode') return undefined;
    const id = elementId(graph as NamedNode);
    return ctx.g.isView(graph) ? id : undefined;
}

/** The number of boxes of each view (graph IRI): its placements of an element (cards, marks, view references). */
function viewBoxCounts(ctx: ExplorerContext, views: Term[]): Map<string, number> {
    if (!views.length) return new Map();
    return new Map(select(ctx.g, `SELECT ?g (COUNT(DISTINCT ?n) AS ?count) WHERE {
        VALUES ?g { ${views.map(v => iri(v.value)).join(' ')} } OPTIONAL { GRAPH ?g { ?n a view:Placement ; view:element ?e } } } GROUP BY ?g`)
        .map(r => [r.g.value, Number(r.count.value)]));
}

/** Violations by focus node: the sh:Violation results of the report graph. */
function violationCounts(ctx: ExplorerContext): Map<string, number> {
    ctx.problems ??= new Map(select(ctx.g, `SELECT ?f (COUNT(?r) AS ?n) WHERE { GRAPH <${VALIDATION_GRAPH}> { ?r sh:focusNode ?f ; sh:resultSeverity sh:Violation } } GROUP BY ?f`)
        .map(r => [r.f.value, Number(r.n.value)]));
    return ctx.problems;
}

/** Badge (views with a placement), grey (none), in the current view, violations of an element. */
function placementState(ctx: ExplorerContext, id: string, uri?: string): Pick<ExplorerRow, 'badge' | 'muted' | 'inView' | 'problems'> {
    const views = ctx.placements.get(id) ?? new Set<string>();
    const problems = uri ? violationCounts(ctx).get(uri) ?? 0 : 0;
    return { badge: String(views.size), muted: views.size === 0, inView: !!ctx.currentView && views.has(ctx.currentView), problems: problems || undefined };
}

/** The row of a resource: its kind and name from the read model, else a label of the store. `graph`: a graph that has it. */
function elementRows(ctx: ExplorerContext, items: { term: Term; graph?: Term }[]): ExplorerRow[] {
    const { shapes } = ctx;
    const named = items.filter(i => i.term.termType === 'NamedNode');
    const found = labels(ctx.g, named.map(i => i.term.value));
    const boxCounts = viewBoxCounts(ctx, named.map(i => i.term).filter(t => ctx.g.isView(t)));
    return named.map(({ term, graph }): ExplorerRow => {
        const id = termId(ctx, term);
        const shape = shapes.nodeShapes[id], property = shapes.properties[id], inst = ctx.g.isInstance(term);
        const view = boxCounts.has(term.value) ? { uri: term.value, boxes: boxCounts.get(term.value)! } : undefined;
        const valueSet = Object.values(shapes.valueSets).find(v => v.uri === term.value);
        if (shape) {
            return {
                key: 'shape:' + id, kind: 'shape', name: found.get(term.value)!, folder: shape.properties.length > 0, element: id, card: id, icon: 'symbol-ruler',
                description: shape.targetClass ? undefined : 'no target class', ...placementState(ctx, id), badge: String(shape.properties.length),
                tooltip: [shape.uri, shape.description, shape.file, 'Node shape. Drag to a view to show its card.'].filter(Boolean).join('\n')
            };
        }
        if (view) {
            return {
                key: id, kind: 'view', name: found.get(term.value)!, folder: false, element: id, icon: 'window', badge: String(view.boxes), inView: id === ctx.currentView,
                tooltip: [view.uri, `${view.boxes} boxes.`, 'Click to open, drag to a view to add a view reference.'].join('\n')
            };
        }
        if (property) return propertyRow(ctx, id);
        const types = typeTriples(ctx).filter(q => q.subject.value === term.value && q.predicate.value === NS.rdf + 'type').map(q => q.object.value);
        if (inst || valueSet || types.length && searchKind(types) === 'instance') {
            return {
                key: id, kind: 'instance', name: found.get(term.value)!, folder: false, element: id, card: valueSet?.id ?? id, ...placementState(ctx, id, term.value),
                tooltip: [term.value, inst ? ctx.fileOf?.(term) : undefined].filter(Boolean).join('\n')
            };
        }
        return { key: id, kind: 'resource', name: found.get(term.value) ?? labelFromIri(term.value), folder: false, element: id, view: viewOf(ctx, graph), icon: 'symbol-misc', tooltip: term.value };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

function classChildren(ctx: ExplorerContext, cls: string): ExplorerRow[] {
    const subclasses = [...new Set(typeTriples(ctx).filter(q => q.predicate.value === NS.rdfs + 'subClassOf' && q.object.value === cls && q.subject.value !== cls).map(q => q.subject.value))];
    const names = classNames(ctx, subclasses);
    return [
        ...subclasses.map(c => classRow(ctx, c, names.get(c)!, typeMembers(ctx, c).length, searchKind([c]) === 'instance')).sort((a, b) => a.name.localeCompare(b.name)),
        ...elementRows(ctx, typeMembers(ctx, cls).map(term => ({ term })))
    ];
}

/** Compatibility for old reveal keys. Untyped labeled things now belong to rdfs:Resource. */
function noClass(ctx: ExplorerContext): ExplorerRow[] {
    return classChildren(ctx, NS.rdfs + 'Resource');
}

function predicates(ctx: ExplorerContext): ExplorerRow[] {
    const counts = new Map<string, number>();
    for (const q of connectionTriples(ctx)) counts.set(q.predicate.value, (counts.get(q.predicate.value) ?? 0) + 1);
    const names = labels(ctx.g, [...counts.keys()]);
    return [...counts].map(([p, n]): ExplorerRow => ({ key: 'rel:' + p, kind: 'folder', name: names.get(p)!, folder: true, badge: String(n), icon: 'arrow-right', tooltip: p }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function relations(ctx: ExplorerContext, predicate: string): ExplorerRow[] {
    const triples = connectionTriples(ctx, predicate);
    const names = labels(ctx.g, [...new Set(triples.flatMap(q => [q.subject.value, q.predicate.value, q.object.value]))]);
    return triples.map((q): ExplorerRow => {
        const id = relationId(q.subject as NamedNode, q.predicate as NamedNode, q.object as NamedNode);
        const name = `${names.get(q.subject.value)} — ${names.get(predicate)} → ${names.get(q.object.value)}`;
        return { key: id, kind: 'relation', name, folder: false, element: id, ...placementState(ctx, id) };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Concepts: schemes, No scheme, collections; a concept expands to its narrower concepts.

const vocabularyOf = (ctx: ExplorerContext) => ctx.content.vocabulary ??= vocabulary(ctx.g);

function concepts(ctx: ExplorerContext): ExplorerRow[] {
    const data = vocabularyOf(ctx);
    const row = (s: { iri: string; label: string }, kind: 'scheme' | 'collection', count: number): ExplorerRow => {
        const id = termId(ctx, rdf.namedNode(s.iri));
        const card = kind === 'scheme' ? valueSetOf(ctx.shapes, { kind: 'scheme', schemes: [s.iri] }) : Object.values(ctx.shapes.valueSets).find(v => v.uri === s.iri)?.id;
        return {
            key: kind + ':' + s.iri, kind: 'folder', name: s.label, folder: true, badge: String(count),
            icon: kind === 'scheme' ? 'symbol-namespace' : 'symbol-array', element: id, card: card ?? id,
            inView: placementState(ctx, id).inView, tooltip: s.iri
        };
    };
    const loose = conceptRoots(data.concepts).get('no-scheme')?.length ?? 0;
    return [
        ...data.schemes.map(s => row(s, 'scheme', data.concepts.filter(c => c.schemes.includes(s.iri)).length)).sort((a, b) => a.name.localeCompare(b.name)),
        ...(loose ? [{ key: 'no-scheme', kind: 'folder', name: 'No scheme', folder: true, badge: String(loose), muted: true } as ExplorerRow] : []),
        ...data.collections.map(s => row(s, 'collection', s.members.length)).sort((a, b) => a.name.localeCompare(b.name))
    ];
}

/** Concept hierarchy and row state are display work over the shared vocabulary read. */
function conceptRows(ctx: ExplorerContext, concepts: ConceptDef[]): ExplorerRow[] {
    const all = vocabularyOf(ctx).concepts;
    return concepts.map((c): ExplorerRow => {
        const id = termId(ctx, rdf.namedNode(c.iri));
        return {
            key: 'concept:' + c.iri, kind: 'concept', name: c.label, folder: all.some(x => x.broader.includes(c.iri)),
            element: id, card: id, icon: 'symbol-enum-member', description: c.notation, ...placementState(ctx, id, c.iri),
            tooltip: [c.iri, c.definition].filter(Boolean).join('\n')
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

function schemeChildren(ctx: ExplorerContext, scheme: string): ExplorerRow[] {
    return conceptRows(ctx, conceptRoots(vocabularyOf(ctx).concepts).get('scheme:' + scheme) ?? []);
}

function noScheme(ctx: ExplorerContext): ExplorerRow[] {
    return conceptRows(ctx, conceptRoots(vocabularyOf(ctx).concepts).get('no-scheme') ?? []);
}

function narrower(ctx: ExplorerContext, concept: string): ExplorerRow[] {
    return conceptRows(ctx, vocabularyOf(ctx).concepts.filter(c => c.broader.includes(concept)));
}

function collectionChildren(ctx: ExplorerContext, collection: string): ExplorerRow[] {
    const members = vocabularyOf(ctx).collections.find(c => c.iri === collection)?.members ?? [];
    return elementRows(ctx, members.map(s => ({ term: rdf.namedNode(s) }))).map(r => ({ ...r, folder: false }));
}

// ---- Node shapes: property shapes from the shapes index (sh:property and the members of sh:or, sh:xone, sh:and lists).

/** The row of a property shape: its sh:name, else its path (as the rows of its card). */
function propertyRow(ctx: ExplorerContext, id: string): ExplorerRow {
    const { shapes } = ctx;
    const p = shapes.properties[id];
    const card = p.minCount === undefined && p.maxCount === undefined ? '' : `[${p.minCount ?? 0}..${p.maxCount ?? '*'}]`;
    return {
        key: id, kind: 'property', name: p.name ?? formatPath(p.path), folder: false, element: id,
        icon: p.range.kind === 'class' || p.range.kind === 'node' ? 'arrow-right' : 'symbol-field',
        description: [rangeText(shapes, p.range), card].filter(Boolean).join(' '),
        tooltip: [formatPath(p.path), verbalizeProperty(shapes, p), p.description].filter(Boolean).join('\n')
    };
}

function propertyRows(ctx: ExplorerContext, shapeId: string): ExplorerRow[] {
    const { shapes } = ctx;
    const shape = shapes.nodeShapes[shapeId];
    return (shape?.properties ?? []).filter(id => shapes.properties[id]).map(id => propertyRow(ctx, id));
}

// ---- Reveal and folder operations

/** The paths to the rows of an element: one per type, the target class of a node shape, the concept tree, the relation type. */
export function explorerPaths(ctx: ExplorerContext, id: string): ExplorerPath[] {
    const { shapes } = ctx;
    const relation = relationTriple(id);
    if (relation) return [{ keys: ['relations', 'rel:' + relation.p.value, id], name: 'Relations' }];
    const property = shapes.properties[id];
    if (property) return explorerPaths(ctx, property.owner).map(p => ({ keys: [...p.keys, id], name: `${p.name} › ${shapes.nodeShapes[property.owner]?.label}` }));
    const term = elementTerm(id);
    if (!term) return [];
    const shape = shapes.nodeShapes[id];
    const rowKey = shape ? 'shape:' + id : id;
    const types = typeTriples(ctx).filter(q => q.subject.value === term.value && q.predicate.value === NS.rdf + 'type').map(q => q.object.value);
    const classes = [...new Set(types)];
    const names = classNames(ctx, classes);
    const paths: ExplorerPath[] = classes.map(c => ({ keys: [classKey(c), rowKey], name: names.get(c)! }));
    const concept = conceptPath(vocabularyOf(ctx).concepts, term.value);
    if (concept) paths.push({ keys: ['concepts', concept.folder, ...concept.broader.map(b => 'concept:' + b), 'concept:' + term.value], name: 'Concepts' });
    if (vocabularyOf(ctx).schemes.some(s => s.iri === term.value)) paths.push({ keys: ['concepts', 'scheme:' + term.value], name: 'Concepts' });
    return paths;
}

/** The element ids of the rows under a node key, at any depth (each folder once: a skos:broader cycle ends). */
export function explorerElements(ctx: ExplorerContext, key: string): string[] {
    const ids = new Set<string>();
    const seen = new Set<string>();
    const visit = (k: string) => {
        if (seen.has(k)) return;
        seen.add(k);
        for (const row of explorerChildren(ctx, k)) {
            if (row.element) ids.add(row.element);
            if (row.folder) visit(row.key);
        }
    };
    visit(key);
    return [...ids];
}
