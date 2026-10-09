import { materializedSubject, shapeQueryScope, shapeTargetMatches } from './shacl-targets';
// SPARQL queries that select a part of the model: the form data of an instance, the links of elements.

import {
    Classes, Doc, ElementKind, LinkElement, LinkRow, Links, NS, SelectionLinks, ViewLink, elementLabel, elementOfId, findRelation, formPredicates, kindOf,
    predicateName, primaryClass, shortIri
} from '@catenary/model';
import type { NamedNode, Quad } from '@rdfjs/types';
import { ModelGraph } from './graph';
import { NOT_REPORT, compareLabels, construct, iri as iriText, labels, statements, thingHead, things } from './sparql';
import { elementId, elementTerm, relationTriple } from './ids';
import type { ShapesIndex } from './shapes-read';
import { rdf, termKey } from './terms';

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX view: <${NS.view}> PREFIX skos: <${NS.skos}> PREFIX sh: <${NS.sh}>`;

const iri = (t: NamedNode) => `<${t.value}>`;

/** Instances of a class at most in the form data (link candidates of the SHACL form). */
export const FORM_CANDIDATE_LIMIT = 200;

/**
 * The SHACL form data as N-Triples: the thing's statements and its link candidates. Empty: not a thing.
 */
export function formData(g: ModelGraph, instance: NamedNode): string {
    const own = formStatements(g, instance);
    return own ? rdf.dataset([...own, ...formCandidates(g, instance)]).toString() : '';
}

/** Statements of a thing across data graphs. Undefined: not a thing. */
export function formStatements(g: ModelGraph, instance: NamedNode): Quad[] | undefined {
    const head = thingHead(g, instance);
    if (!head) return undefined;
    const materialized = materializedSubject(g, instance.value);
    return materialized ? [...materialized] : statements(g, [instance.value]);
}

/**
 * Form candidates: things of each sh:class range or its subclasses, with types and shared display labels.
 * Shape paths include logical constraints. Each class contributes at most FORM_CANDIDATE_LIMIT candidates, sorted by label.
 * The selected thing is not a candidate. The report graph contributes no data.
 */
export function formCandidates(g: ModelGraph, instance: NamedNode): Quad[] {
    const head = thingHead(g, instance);
    if (!head) return [];
    const steps = 'sh:property|sh:node|sh:or|sh:and|sh:xone|sh:not|sh:qualifiedValueShape|rdf:first|rdf:rest';
    const applicable = shapeTargetMatches(g, { nodes: [{ termType: 'NamedNode', value: instance.value }] });
    if (!applicable.length) return [];
    const found = construct(g, `CONSTRUCT { ?ps sh:class ?c . ?sub rdfs:subClassOf ?c }
        ${shapeQueryScope(g).data.map(t => `FROM ${iriText(t)}`).join(' ')} WHERE {
        VALUES ?ns { ${applicable.map(m => iriText(m.shape)).join(' ')} }
        ?ns (${steps})+ ?ps . ?ps sh:class ?c .
        OPTIONAL { ?sub rdfs:subClassOf+ ?c }
    }`);
    const classes = [...new Set(found.flatMap(q => q.predicate.value === NS.sh + 'class' ? [q.object.value] : [q.subject.value]))];
    if (!classes.length) return [];
    const candidates = construct(g, `CONSTRUCT { ?s rdf:type ?type } WHERE {
        VALUES ?type { ${classes.map(iriText).join(' ')} }
        { ${things()} } FILTER (?s != ${iri(instance)})
    }`);
    const names = labels(g, [...new Set(candidates.map(q => q.subject.value))]);
    const result: Quad[] = [];
    for (const c of classes) {
        const chosen = candidates.filter(q => q.object.value === c)
            .sort((a, b) => compareLabels(names.get(a.subject.value)!, names.get(b.subject.value)!) || a.subject.value.localeCompare(b.subject.value))
            .slice(0, FORM_CANDIDATE_LIMIT);
        for (const q of chosen) result.push(q, rdf.quad(q.subject, rdf.namedNode(NS.rdfs + 'label'), rdf.literal(names.get(q.subject.value)!)));
    }
    return [...rdf.dataset(result)];
}

/**
 * Links of elements of any kind (ids): the views that show each one, and the statements of the model and shapes graphs from and to it.
 * Literals are left out (rdf:type statements are kept, UI §8.8); an RDF list (sh:or, sh:in, …) between two terms counts as one step with the predicate
 * that holds the list; a statement from the element to itself is only 'out'. View graphs count only as views. A property shape or logical constraint is shown by the card of its node shape.
 * Property shapes and logical constraints map to their ids; `isElement` tells which other IRI ids the user interface knows.
 */
export function links(g: ModelGraph, idx: ShapesIndex, ids: string[], isElement: (id: string) => boolean): Links {
    const values: string[] = [], relations: string[] = [];
    for (const id of new Set(ids)) {
        const r = relationTriple(id);
        if (r) { relations.push(`(${JSON.stringify(id)} <${r.s.value}> <${r.p.value}> <${r.o.value}>)`); continue; }
        const prop = idx.property.get(id), cons = idx.constraint.get(id);
        const term = prop?.term ?? cons?.head ?? elementTerm(id);
        if (term?.termType !== 'NamedNode') continue;
        const card = prop?.owner ?? cons?.owner ?? term;
        values.push(`(${JSON.stringify(id)} ${iri(term as NamedNode)} ${iri(card)})`);
    }
    const graphs = `FILTER (?g IN (${[g.model, ...g.shapesGraphs()].map(iri).join(', ')}))`;
    const noStep = `FILTER (?p NOT IN (rdf:first, rdf:rest))`;
    const views: ViewLink[] = [], rows: LinkRow[] = [];
    if (values.length) {
        const found = g.store.select(`${PREFIXES}
            SELECT ?eid ?dir ?p ?o ?v (SAMPLE(?l) AS ?label) WHERE {
                VALUES (?eid ?e ?c) { ${values.join(' ')} }
                {
                    { GRAPH ?g { ?e ?p ?x } ${graphs} ${noStep} FILTER (!isLiteral(?x))
                      OPTIONAL { GRAPH ?g { ?x rdf:rest*/rdf:first ?m } }
                      BIND (COALESCE(?m, ?x) AS ?o) }
                    UNION
                    { GRAPH ?g { ?e rdf:first ?first . ?e rdf:rest*/rdf:first ?o . ?holder ?p ?e } ${graphs} ${noStep} }
                    FILTER (?o != rdf:nil) BIND ("out" AS ?dir)
                    OPTIONAL { GRAPH ?lg { ?o rdfs:label|skos:prefLabel|sh:name ?l } }
                }
                UNION
                {
                    { GRAPH ?g { ?o ?p ?e } ${graphs} ${noStep} }
                    UNION
                    { GRAPH ?g { ?list rdf:rest*/rdf:first ?e . ?o ?p ?list } ${graphs} ${noStep} }
                    FILTER (!sameTerm(?o, ?e)) BIND ("in" AS ?dir)
                    OPTIONAL { GRAPH ?lg { ?o rdfs:label|skos:prefLabel|sh:name ?l } }
                }
                UNION
                {
                    { GRAPH ?v { ?n view:element ?c } }
                    UNION { GRAPH ?v { ?e a ?vt } FILTER (?vt != view:View) }
                    GRAPH ?v { ?vs a view:View }
                }
            } GROUP BY ?eid ?dir ?p ?o ?v`);
        const constraintOf = new Map([...idx.constraint].map(([cid, c]) => [termKey(c.head), cid]));
        const seen = new Set<string>();
        for (const b of found) {
            const element = b.eid.value;
            if (b.v) {
                const view = elementId(b.v as NamedNode);
                if (!seen.has(element + ' ' + view)) views.push({ element, view });
                seen.add(element + ' ' + view);
                continue;
            }
            const o = b.o;
            const key = termKey(o);
            const id = idx.byTerm.get(key) ?? constraintOf.get(key)
                ?? (o.termType === 'NamedNode' && isElement(elementId(o as NamedNode)) ? elementId(o as NamedNode) : undefined);
            rows.push({
                element, dir: b.dir.value as 'out' | 'in', predicate: b.p.value, id,
                iri: o.termType === 'NamedNode' ? o.value : undefined, label: b.label?.value
            });
        }
    }
    if (relations.length) {
        const found = g.store.select(`${PREFIXES}
            SELECT DISTINCT ?eid ?v ?h WHERE {
                VALUES (?eid ?s ?p ?o) { ${relations.join(' ')} }
                GRAPH ${iri(g.model)} { ?s ?p ?o }
                GRAPH ?v { ?vs a view:View . ?a view:element ?s . ?b view:element ?o }
                BIND (NOT EXISTS { GRAPH ?v { ?edge rdf:reifies <<( ?s ?p ?o )>> } } AS ?h)
            }`);
        // Hidden: both ends in the view, no placement of the relation.
        for (const b of found) views.push({ element: b.eid.value, view: elementId(b.v as NamedNode), ...(b.h?.value === 'true' ? { hidden: true } : {}) });
    }
    return { views, rows };
}

/**
 * The Links panel data of a selection (ADR 0007): `ids` are the selected ids of `view` (a placement gives its element; groups, notes, …
 * are found in `view` only). The links query above, with the labels, kinds and relations of the read model of the backend.
 */
export function selectionLinks(g: ModelGraph, idx: ShapesIndex, doc: Doc, meta: Classes, ids: string[], view?: string): SelectionLinks {
    const v = view ? doc.views[view] : undefined;
    const label = (id: string) => elementLabel(doc, meta, id, v) ?? id;
    const elements: LinkElement[] = [];
    for (const id of new Set(ids.map(id => elementOfId(v, id)))) {
        const kind = kindOf(doc, v, id);
        if (!kind) continue;
        const r = doc.relations[id];
        elements.push({
            id, kind, label: label(id),
            kindName: kind === 'instance' ? primaryClass(meta, doc.instances[id].types)?.name ?? 'Instance' : KIND_NAMES[kind],
            ...(r ? { ends: { subject: r.subject, object: r.object, subjectLabel: label(r.subject), objectLabel: label(r.object) } } : {})
        });
    }
    // `doc` reads the selection only: an instance of the store outside it (an instance of a selected class) is an element too.
    const inStore = (id: string) => g.isInstance(elementTerm(id));
    const isElement = (id: string) => !!(doc.instances[id] || doc.views[id] || doc.shapes.nodeShapes[id] || doc.shapes.valueSets[id]) || inStore(id);
    const found = links(g, idx, elements.map(e => e.id), isElement);
    const rows = found.rows.map(r => {
        const known = !!r.id && !!kindOf(doc, undefined, r.id);
        const target = r.id && (known || inStore(r.id)) ? r.id : undefined;
        const [s, o] = r.dir === 'out' ? [r.element, target] : [target, r.element];
        const relation = s && o && doc.instances[s] && doc.instances[o] ? findRelation(doc, s, r.predicate, o)?.id : undefined;
        const inst = doc.instances[r.element];
        const cls = inst && primaryClass(meta, inst.types);
        const undeclared = r.dir === 'out' && !!relation && !!cls && !formPredicates(cls).includes(r.predicate);
        return {
            ...r, id: target, name: r.label ?? (known ? label(target!) : r.iri ? shortIri(r.iri) : 'blank node'), predicateName: predicateName(meta, r.predicate),
            ...(relation ? { relation } : {}), ...(undeclared ? { undeclared } : {})
        };
    });
    const views = found.views.filter(x => doc.views[x.view]).map(x => ({ ...x, label: doc.views[x.view].label }));
    const instances = new Map<string, { id: string; label: string; shapes: string[] }>();
    for (const shape of elements.filter(e => e.kind === 'shape')) {
        const term = elementTerm(shape.id);
        if (!term) continue;
        const found = shapeTargetMatches(g, { shapes: [term.value] })
            .filter(m => m.node.termType === 'NamedNode' && g.isInstance(rdf.namedNode(m.node.value)))
            .map(m => ({ s: rdf.namedNode(m.node.value) }));
        const names = labels(g, found.map(b => b.s.value));
        for (const b of found) {
            const id = elementId(b.s as NamedNode);
            const row = instances.get(id) ?? { id, label: names.get(b.s.value) ?? shortIri(b.s.value), shapes: [] };
            row.shapes.push(shape.id);
            instances.set(id, row);
        }
    }
    return { elements, views, rows, instances: [...instances.values()].sort((a, b) => compareLabels(a.label, b.label) || a.id.localeCompare(b.id)) };
}

/** Kind names of the Links panel head (an instance: its class). */
const KIND_NAMES: Record<ElementKind, string> = {
    instance: 'Instance', relation: 'Relation', view: 'View', group: 'Group', note: 'Note', reference: 'View reference', collection: 'Collection',
    arrow: 'Arrow', shape: 'Node shape', property: 'Property shape', constraint: 'Logical constraint', valueSet: 'Value set'
};
