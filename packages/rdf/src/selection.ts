// Resolve window selection IDs from RDF facts. The shapes index only translates existing UI identities.

import { ElementKind, ModelSelection, NS, Selected, emptySelected, searchKind } from '@catenary/model';
import type { NamedNode, Quad, Quad_Object, Quad_Subject, Term } from '@rdfjs/types';
import type { TextTarget } from 'rdf-files';
import { ModelGraph, VALIDATION_GRAPH, cmp } from './graph';
import { elementId, elementTerm, relationId, relationTriple } from './ids';
import type { Settings } from './settings';
import type { ShapesIndex } from './shapes-read';
import { connections, construct, iri, rows, statements, statementsByTerm, things } from './sparql';
import { rdf, termKey } from './terms';

const buckets: Record<ElementKind, keyof Pick<Selected, 'instances' | 'relations' | 'views' | 'groups' | 'notes' | 'references' | 'collections' | 'arrows' | 'shapes' | 'properties' | 'constraints' | 'valueSets'>> = {
    instance: 'instances', relation: 'relations', view: 'views', group: 'groups', note: 'notes', reference: 'references',
    collection: 'collections', arrow: 'arrows', shape: 'shapes', property: 'properties', constraint: 'constraints', valueSet: 'valueSets'
};
const marks: Record<string, ElementKind> = {
    [NS.view + 'Frame']: 'group', [NS.view + 'Note']: 'note', [NS.view + 'FileRef']: 'reference', [NS.view + 'EntityGroup']: 'collection'
};

/**
 * Preserve placement IDs in `ids`, but resolve cards and edges to their element IDs in `elements`. The placement statements and the
 * facts are indexed by subject once: a term of the store compares in WebAssembly, so a scan of them for each id cost seconds for a
 * few hundred ids (§11.3 readBudgetMs).
 */
export function selected(g: ModelGraph, index: ShapesIndex, selection: ModelSelection): Selected {
    const answer: Selected = { ...emptySelected(), view: undefined };
    const viewTerm = selection.view ? elementTerm(selection.view) : undefined;
    const ids = [...new Set(selection.ids)];
    if (viewTerm && g.match(viewTerm, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'View'), viewTerm).length) answer.view = selection.view;
    // The statements of each selected id in the view graph: its types, and the first view:element and rdf:reifies.
    const placements = new Map<string, { placed: boolean; target?: Term; triple?: Term }>();
    if (answer.view) for (const id of ids) {
        const term = elementTerm(id);
        if (!term) continue;
        const entry = { placed: false } as { placed: boolean; target?: Term; triple?: Term };
        for (const q of g.match(term, null, null, viewTerm)) {
            const p = q.predicate.value;
            if (p === NS.rdf + 'type') entry.placed ||= q.object.value === NS.view + 'Placement';
            else if (p === NS.view + 'element') entry.target ??= q.object;
            else if (p === NS.rdf + 'reifies') entry.triple ??= q.object;
        }
        placements.set(id, entry);
    }
    const candidates = ids.map(id => {
        const term = elementTerm(id);
        const entry = term ? placements.get(id) : undefined;
        return { id, term, target: entry?.placed ? entry.target : undefined, triple: entry?.placed ? entry.triple : undefined };
    });
    const iris = [...new Set(candidates.flatMap(c => [c.target?.termType === 'NamedNode' ? c.target.value : c.term?.value].filter((s): s is string => !!s)))];
    const factTypes = new Map<string, string[]>();
    for (const q of statements(g, iris)) if (q.predicate.value === NS.rdf + 'type') factTypes.set(q.subject.value, [...factTypes.get(q.subject.value) ?? [], q.object.value]);
    const types = new Map<string, string[]>();
    if (iris.length) for (const q of construct(g, `CONSTRUCT { ?s rdf:type ?type } WHERE {
        VALUES ?s { ${iris.map(iri).join(' ')} } { ${things()} }
    }`)) types.set(q.subject.value, [...(types.get(q.subject.value) ?? []), q.object.value]);
    const identity = (s: string) => index.byTerm.get(termKey(rdf.namedNode(s))) ?? elementId(rdf.namedNode(s));
    const kind = (id: string, s?: string): ElementKind | undefined => {
        if (index.model.nodeShapes[id]) return 'shape';
        if (index.model.valueSets[id]) return 'valueSet';
        if (index.model.properties[id]) return 'property';
        if (index.model.constraints[id]) return 'constraint';
        const ts = s ? types.get(s) : undefined;
        if (!ts) return undefined;
        return searchKind(ts);
    };
    // The triple of each relation candidate, and one query for the connections among them.
    const tripleOf = (c: typeof candidates[number]) => c.triple?.termType === 'Quad' && c.triple.subject.termType === 'NamedNode' && c.triple.object.termType === 'NamedNode'
        ? { s: c.triple.subject, p: c.triple.predicate as NamedNode, o: c.triple.object } : relationTriple(c.id);
    const tripleKey = (t: { s: NamedNode; p: NamedNode; o: NamedNode }) => `${iri(t.s.value)} ${iri(t.p.value)} ${iri(t.o.value)}`;
    const relationTriples = candidates.filter(c => c.target?.termType !== 'NamedNode').flatMap(c => {
        const t = tripleOf(c);
        return t && !(c.triple && t.p.value === NS.view + 'arrow') ? [t] : [];
    });
    const connected = new Set(relationTriples.length ? construct(g, `CONSTRUCT { ?s ?p ?o } WHERE {
        VALUES (?s ?p ?o) { ${[...new Set(relationTriples.map(t => `(${tripleKey(t)})`))].join(' ')} }
        ${connections()}
    }`).map(q => tripleKey({ s: q.subject as NamedNode, p: q.predicate as NamedNode, o: q.object as NamedNode })) : []);
    for (const c of candidates) {
        let element = c.id;
        let k: ElementKind | undefined;
        if (c.target?.termType === 'NamedNode') {
            const targetTypes = factTypes.get(c.target.value) ?? [];
            k = targetTypes.map(t => marks[t]).find(Boolean);
            if (!k && targetTypes.includes(NS.view + 'View')) k = 'reference';
            if (!k) { element = identity(c.target.value); k = kind(element, c.target.value); }
        } else {
            const triple = tripleOf(c);
            if (triple) {
                const { s, p, o } = triple;
                if (c.triple && p.value === NS.view + 'arrow') k = 'arrow';
                else if (connected.has(tripleKey(triple))) { element = relationId(s, p, o); k = 'relation'; }
            } else k = kind(c.id, c.term?.value);
        }
        if (!k) continue;
        answer.ids.push(c.id);
        if (!answer.elements.includes(element)) {
            answer.elements.push(element);
            answer[buckets[k]].push(element);
        }
    }
    return answer;
}

/** Subject statements, or object statements when none exist. A relation uses its triple. One element of `statementsOfAll`. */
export function statementsOf(g: ModelGraph, index: () => ShapesIndex, id: string): Quad[] {
    return statementsOfAll(g, index, [id]).get(id) ?? [];
}

/**
 * The statements of each element with their graphs (not the report): a relation, the statements of its triple; another element, the
 * statements of its term as subject, or as object when there are none. Three queries for all elements (§11.3 readBudgetMs).
 */
export function statementsOfAll(g: ModelGraph, index: () => ShapesIndex, ids: Iterable<string>): Map<string, Quad[]> {
    const out = new Map<string, Quad[]>();
    const triples = new Map<string, string[]>(), termIds = new Map<string, string[]>();
    const idx = index();
    for (const id of new Set(ids)) {
        const triple = relationTriple(id);
        if (triple) { const key = `${iri(triple.s.value)} ${iri(triple.p.value)} ${iri(triple.o.value)}`; triples.set(key, [...triples.get(key) ?? [], id]); continue; }
        const t = idx.property.get(id)?.term ?? idx.constraint.get(id)?.owner ?? elementTerm(id);
        if (!t) { out.set(id, []); continue; }
        termIds.set(t.value, [...termIds.get(t.value) ?? [], id]);
    }
    if (triples.size) {
        const found = new Map<string, Quad[]>();
        for (const r of rows(g, `SELECT ?s ?p ?o ?g WHERE { VALUES (?s ?p ?o) { ${[...triples.keys()].map(k => `(${k})`).join(' ')} } GRAPH ?g { ?s ?p ?o } }`)) {
            const key = `${iri(r.s.value)} ${iri(r.p.value)} ${iri(r.o.value)}`;
            found.set(key, [...found.get(key) ?? [], rdf.quad(r.s as Quad_Subject, r.p as NamedNode, r.o as Quad_Object, r.g as NamedNode)]);
        }
        for (const [key, list] of triples) for (const id of list) out.set(id, found.get(key) ?? []);
    }
    if (termIds.size) {
        const found = statementsByTerm(g, termIds.keys());
        for (const [term, list] of termIds) for (const id of list) out.set(id, found.get(term) ?? []);
    }
    return out;
}

/** Text positions, best first: own block, property entry, then the containing shape. */
export function textTargets(idx: ShapesIndex, id: string): TextTarget[] {
    const rel = relationTriple(id);
    if (rel) return [{ subject: rel.s.value, predicate: rel.p.value, object: rel.o.value }];
    const property = idx.property.get(id), constraint = idx.constraint.get(id);
    if (property) {
        const path = idx.model.properties[id]?.path, p = NS.sh + 'property', own = property.term.value;
        return [
            { subject: own }, { subject: property.owner.value, predicate: p, object: own },
            ...(path?.kind === 'iri' ? [{ subject: property.owner.value, predicate: p, inside: { predicate: NS.sh + 'path', object: path.iri } }] : []),
            { subject: property.owner.value }
        ];
    }
    if (constraint) return [{ subject: constraint.owner.value, predicate: NS.sh + constraint.operator }, { subject: constraint.owner.value }];
    const t = elementTerm(id);
    return t?.termType === 'NamedNode' ? [{ subject: t.value }] : [];
}

/** Source files of an element, most statements first. One element of `filesOfElements`. */
export function filesOfElement(g: ModelGraph, idx: () => ShapesIndex, settings: Settings | undefined, id: string): string[] {
    return filesOfElements(g, idx, settings, [id]).get(id) ?? [];
}

/** The files of the statements, most statements first. */
const filesOfQuads = (settings: Settings | undefined, quads: Quad[]): string[] => {
    const count = new Map<string, number>();
    for (const q of quads) for (const f of settings?.filesOfQuad(q) ?? []) count.set(f, (count.get(f) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([f]) => f);
};

/**
 * Source files of several elements: one query for the subject statements of all terms, one for the object statements of the terms
 * without any, grouped by graph (§11.3 readBudgetMs). The relations, and the terms with statements in the logical model graph itself,
 * take their statements in three more queries (statementsOfAll).
 */
export function filesOfElements(g: ModelGraph, index: () => ShapesIndex, settings: Settings | undefined, ids: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const byStatements: string[] = [];
    const termIds = new Map<string, string[]>();
    const idx = index();
    for (const id of new Set(ids)) {
        if (relationTriple(id)) { byStatements.push(id); continue; }
        const t = idx.property.get(id)?.term ?? idx.constraint.get(id)?.owner ?? elementTerm(id);
        if (!t) { result.set(id, []); continue; }
        termIds.set(t.value, [...termIds.get(t.value) ?? [], id]);
    }
    const finish = () => {
        if (byStatements.length) for (const [id, quads] of statementsOfAll(g, index, byStatements)) result.set(id, filesOfQuads(settings, quads));
        return result;
    };
    if (!termIds.size) return finish();
    const counts = new Map<string, Map<string, number>>();
    const fromModel = new Set<string>();
    const scan = (terms: string[], bound: 's' | 'o') => {
        const free = bound === 's' ? 'o' : 's';
        for (const r of rows(g, `SELECT ?${bound} ?g (SAMPLE(?p) AS ?p1) (SAMPLE(?${free}) AS ?${free}1) (COUNT(*) AS ?n) WHERE {
            VALUES ?${bound} { ${terms.map(iri).join(' ')} } GRAPH ?g { ?s ?p ?o } FILTER (?g != <${VALIDATION_GRAPH}>)
        } GROUP BY ?${bound} ?g`)) {
            const term = r[bound].value;
            if (r.g.equals(g.model)) { fromModel.add(term); continue; }
            const count = counts.get(term) ?? new Map<string, number>();
            counts.set(term, count);
            const sample = rdf.quad((bound === 's' ? r.s : r.s1) as Quad_Subject, r.p1 as NamedNode, (bound === 'o' ? r.o : r.o1) as Quad_Object, r.g as NamedNode);
            for (const f of settings?.filesOfQuad(sample) ?? []) count.set(f, (count.get(f) ?? 0) + Number(r.n.value));
        }
    };
    scan([...termIds.keys()], 's');
    const objectsOnly = [...termIds.keys()].filter(t => !counts.has(t) && !fromModel.has(t));
    if (objectsOnly.length) scan(objectsOnly, 'o');
    for (const [term, list] of termIds) {
        if (fromModel.has(term)) { byStatements.push(...list); continue; }
        const files = [...counts.get(term) ?? []].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([f]) => f);
        for (const id of list) result.set(id, files);
    }
    return finish();
}
