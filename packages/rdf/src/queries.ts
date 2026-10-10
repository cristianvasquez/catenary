import { materializedSubject, shapeQueryScope, shapeTargetMatches } from './shacl-targets';
// SPARQL queries that select a part of the model: the form data of an instance, the links of elements.

import {
    AppearanceData, Classes, Doc, ElementKind, LinkElement, LinkRow, Links, NS, SelectionLinks, ViewLink, elementLabel, elementOfId, findRelation, formPredicates, kindOf,
    ViewProperties, predicateName, primaryClass, schemaRanges, shortIri
} from '@catenary/model';
import type { NamedNode, Quad } from '@rdfjs/types';
import { ModelGraph, P, SKOS_MEMBERSHIP, SKOS_TYPES, cmp, labelFromIri } from './graph';
import { NOT_REPORT, compareLabels, construct, iri as iriText, labels, statements, thingHead, things } from './sparql';
import { elementId, elementTerm, relationId, relationTriple } from './ids';
import type { ShapesIndex } from './shapes-read';
import { rdf, termKey } from './terms';
import { cardIdsOf } from './records';
import { viewLabels } from './view-read';

const PREFIXES = `PREFIX rdf: <${NS.rdf}> PREFIX rdfs: <${NS.rdfs}> PREFIX view: <${NS.view}> PREFIX skos: <${NS.skos}> PREFIX sh: <${NS.sh}>`;

const iri = (t: NamedNode) => `<${t.value}>`;

/** Instances of a class at most in the form data (link candidates of the SHACL form). */
export const FORM_CANDIDATE_LIMIT = 200;

/**
 * The SHACL form data as N-Triples: the thing's statements and its link candidates. Empty: not a thing. `meta`: the class ranges of
 * its schema rules (schemaRanges) also give candidates.
 */
export function formData(g: ModelGraph, instance: NamedNode, meta?: Classes): string {
    const own = formStatements(g, instance);
    return own ? rdf.dataset([...own, ...formCandidates(g, instance, meta)]).toString() : '';
}

/** Statements of a thing across data graphs. Undefined: not a thing. */
export function formStatements(g: ModelGraph, instance: NamedNode): Quad[] | undefined {
    const head = thingHead(g, instance);
    if (!head) return undefined;
    const materialized = materializedSubject(g, instance.value);
    return materialized ? [...materialized] : statements(g, [instance.value]);
}

/**
 * Form candidates: things of each sh:class range or its subclasses, and of each class range of the schema rules of the thing's
 * classes (`meta`), with types and shared display labels.
 * Shape paths include logical constraints. Each class contributes at most FORM_CANDIDATE_LIMIT candidates, sorted by label.
 * The selected thing is not a candidate. The report graph contributes no data.
 */
export function formCandidates(g: ModelGraph, instance: NamedNode, meta?: Classes): Quad[] {
    const head = thingHead(g, instance);
    if (!head) return [];
    const steps = 'sh:property|sh:node|sh:or|sh:and|sh:xone|sh:not|sh:qualifiedValueShape|rdf:first|rdf:rest';
    const applicable = shapeTargetMatches(g, { nodes: [{ termType: 'NamedNode', value: instance.value }] });
    const found = applicable.length ? construct(g, `CONSTRUCT { ?ps sh:class ?c . ?sub rdfs:subClassOf ?c }
        ${shapeQueryScope(g).data.map(t => `FROM ${iriText(t)}`).join(' ')} WHERE {
        VALUES ?ns { ${applicable.map(m => iriText(m.shape)).join(' ')} }
        ?ns (${steps})+ ?ps . ?ps sh:class ?c .
        OPTIONAL { ?sub rdfs:subClassOf+ ?c }
    }`) : [];
    const classes = [...new Set([...found.flatMap(q => q.predicate.value === NS.sh + 'class' ? [q.object.value] : [q.subject.value]),
        ...(meta ? schemaRanges(meta, head.types) : [])])];
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

/** Hidden instance links need placement membership and endpoint labels, not card fields or a diagram projection. */
export function hiddenRelations(g: ModelGraph, viewId: string, meta: Classes): AppearanceData['hidden'] {
    const view = elementTerm(viewId);
    if (!view) return [];
    const collected = new Set<string>();
    const placed = new Set(g.match(null, rdf.namedNode(NS.view + 'element'), null, view).flatMap(q => q.object.termType === 'NamedNode' ? [q.object.value] : []));
    for (const group of placed) for (const q of g.match(rdf.namedNode(group), rdf.namedNode(NS.view + 'member'))) {
        if (q.object.termType === 'NamedNode') { placed.add(q.object.value); collected.add(q.object.value); }
    }
    const cards = [...placed].filter(s => g.isInstance(rdf.namedNode(s)));
    if (!cards.length) return [];
    const values = cards.map(s => `<${s}>`).join(' '), list = cards.map(s => `<${s}>`).join(', ');
    const graphs = [g.model, ...g.shapesGraphs()].map(iri).join(', ');
    const rows = g.store.select(`${PREFIXES} SELECT DISTINCT ?s ?p ?o ?g WHERE {
        VALUES ?s { ${values} } GRAPH ?g { ?s ?p ?o }
        FILTER (?g IN (${graphs}) && ?o IN (${list}) && ?p NOT IN (rdf:type, rdfs:label))
    }`).filter(r => r.g.value === g.homeOf(rdf.namedNode(r.s.value)).value)
        .sort((a, b) => cmp(a.s.value, b.s.value) || cmp(a.p.value, b.p.value) || cmp(a.o.value, b.o.value));
    const label = (s: string) => {
        const term = rdf.namedNode(s), home = g.homeOf(term);
        const literals = (p: string) => g.match(term, rdf.namedNode(p), null, home).filter(q => q.object.termType === 'Literal').map(q => q.object.value).sort(cmp);
        return literals(NS.rdfs + 'label')[0] ?? literals(NS.skos + 'prefLabel')[0] ?? labelFromIri(s);
    };
    return rows.filter(r => !collected.has(r.s.value) && !collected.has(r.o.value)
        && !g.match(null, rdf.namedNode(NS.rdf + 'reifies'), rdf.quad(r.s as NamedNode, r.p as NamedNode, r.o as NamedNode), view).length)
        .map(r => ({ id: relationId(r.s as NamedNode, r.p as NamedNode, r.o as NamedNode),
            label: `${label(r.s.value)} — ${predicateName(meta, r.p.value)} → ${label(r.o.value)}` }));
}

/** View counts read membership, types and relation endpoints. They do not load card fields or build a diagram. */
export function viewCounts(g: ModelGraph, idx: ShapesIndex, viewId: string): ViewProperties | undefined {
    const view = elementTerm(viewId);
    if (!view || !g.isView(view)) return undefined;
    const viewQuads = g.match(null, null, null, view);
    const placements = new Set(viewQuads.filter(q => q.predicate.equals(P.type) && q.object.value === NS.view + 'Placement').map(q => q.subject.value));
    const elements = viewQuads.filter(q => q.predicate.value === NS.view + 'element' && q.object.termType === 'NamedNode' && placements.has(q.subject.value));
    const values = [...new Set(elements.map(q => q.object.value))].map(s => `<${s}>`).join(' ');
    // The same bounded query reads element heads and group-member heads. It never reads card fields.
    const facts = values ? g.store.select(`${PREFIXES} SELECT DISTINCT ?s ?p ?o ?g WHERE {
        { VALUES ?s { ${values} } } UNION { VALUES ?root { ${values} } GRAPH ?owner { ?root view:member ?s } FILTER(isIRI(?s)) }
        GRAPH ?g { ?s ?p ?o }
        FILTER(?p IN (rdf:type, rdfs:label, view:member, view:file, skos:inScheme, skos:topConceptOf))
    }`) : [];
    const bySubject = new Map<string, typeof facts>();
    for (const row of facts) {
        const rows = bySubject.get(row.s.value) ?? [];
        rows.push(row);
        bySubject.set(row.s.value, rows);
    }
    const shapeGraphs = new Set(g.shapesGraphs().map(t => t.value));
    const homes = new Map<string, string>();
    for (const [s, rows] of bySubject) {
        if (s === g.model.value) continue;
        if (rows.some(r => r.g.value === g.model.value && [NS.rdf + 'type', NS.rdfs + 'label'].includes(r.p.value))) homes.set(s, g.model.value);
        else {
            const graphs = rows.filter(r => shapeGraphs.has(r.g.value) &&
                (SKOS_MEMBERSHIP.some(p => p.value === r.p.value) || r.p.value === NS.rdf + 'type' && SKOS_TYPES.some(t => t.value === r.o.value)))
                .map(r => r.g.value).sort(cmp);
            if (graphs.length) homes.set(s, graphs[0]);
        }
    }
    const instances = new Map([...homes.keys()].map(s => [s, elementId(rdf.namedNode(s))]));
    const known = cardIdsOf(instances, idx.model), cards = new Set<string>(), members = new Set<string>();
    const labels = viewLabels(g);
    let notes = 0, references = 0;
    for (const q of elements) {
        const term = q.object as NamedNode, rows = bySubject.get(term.value) ?? [];
        const type = (name: string) => rows.some(r => r.p.value === NS.rdf + 'type' && r.o.value === NS.view + name);
        if (type('EntityGroup')) {
            for (const r of rows) if (r.p.value === NS.view + 'member' && r.o.termType === 'NamedNode' && known.has(r.o.value)) members.add(r.o.value);
        } else if (type('FileRef')) {
            if (rows.some(r => r.p.value === NS.view + 'file')) references++;
        } else if (type('Note')) notes++;
        else if (labels[elementId(term)] !== undefined) references++;
        else if (!type('Frame') && known.has(term.value) && !term.value.startsWith('urn:trellis:list:')) cards.add(term.value);
    }
    const ends = [...new Set([...cards, ...members])].filter(s => homes.has(s));
    const endValues = ends.map(s => `<${s}>`).join(' ');
    const links = endValues ? g.store.select(`${PREFIXES} SELECT ?s ?p ?o ?g WHERE {
        VALUES ?s { ${endValues} } VALUES ?o { ${endValues} } GRAPH ?g { ?s ?p ?o }
        FILTER(?p NOT IN (rdf:type, rdfs:label))
    }`).filter(r => r.g.value === homes.get(r.s.value)) : [];
    const placedLinks = new Set(viewQuads.filter(q => q.predicate.value === NS.rdf + 'reifies').map(q => termKey(q.object)));
    const hidden = links.filter(r => !members.has(r.s.value) && !members.has(r.o.value)
        && !placedLinks.has(termKey(rdf.quad(r.s as NamedNode, r.p as NamedNode, r.o as NamedNode)))).length;
    const shapes = [...cards].filter(s => !!idx.model.nodeShapes[known.get(s)!]).length;
    return { kind: 'view', id: viewId, uri: view.value, label: labels[viewId],
        description: viewQuads.find(q => q.subject.equals(view) && q.predicate.value === NS.view + 'description')?.object.value ?? '',
        cards: cards.size - shapes, shapes, notes, references, relations: links.length, hidden };
}
