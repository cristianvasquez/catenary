// The link picker reads things and statements from the store. The metamodel (shapes and RDFS rules) supplies relation choices and
// cardinalities.

import { ANY_RESOURCE, Classes, LinkSection, NS, ShapesModel, instanceNoun, outgoingRelations, primaryClass } from '@catenary/model';
import { ModelGraph } from './graph';
import { elementId, elementTerm } from './ids';
import { NOT_REPORT, compareLabels, construct, iri, labels, rows, str, thingHead, things } from './sparql';
import { rdf } from './terms';

/** Candidates of a section at most. */
export const LINK_LIMIT = 50;

export interface LinkContext {
    g: ModelGraph;
    meta: Classes;
    shapes: ShapesModel;
}

export type LinkChoices = { title: string; sections: LinkSection[] } | { error: string } | undefined;

/** The first unused numbered label. Only things with a written label reserve a number. */
export function freeUnnamedLabel(g: ModelGraph, noun: string): string {
    const base = `unnamed ${noun.toLowerCase()}`;
    const found = construct(g, `CONSTRUCT { ?s rdf:type ?type } WHERE {
        { ${things()} }
        GRAPH ?lg { ?s rdfs:label|skos:prefLabel|sh:name ?name }
        FILTER (?lg != ${NOT_REPORT} && STRSTARTS(STR(?name), ${str(base)}))
    }`);
    const used = new Set(labels(g, [...new Set(found.map(q => q.subject.value))]).values());
    for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Link candidates: the requested type, allowed values, missing link and available cardinality. */
export function linkChoices(ctx: LinkContext, dir: 'out' | 'in', from: string, viewId: string, text?: string): LinkChoices {
    const { g, meta, shapes } = ctx;
    const term = elementTerm(from);
    if (term?.termType !== 'NamedNode') return undefined;
    const self = thingHead(g, term);
    if (!self) return undefined;
    const name = primaryClass(meta, self.types)?.name ?? 'unknown class';
    const types = dir === 'out'
        ? outgoingRelations(meta, self.types).map(r => ({ r, other: r.targetClass }))
        : meta.classes.flatMap(c => c.relations.filter(r => (r.targetClass === ANY_RESOURCE || self.types.includes(r.targetClass)) && (!r.values || r.values.includes(term.value))).map(r => ({ r, other: c.iri })));
    if (!types.length) return { error: `The schema declares no relations ${dir === 'out' ? 'from' : 'to'} ${name}.` };

    const F = iri(term.value);
    const view = elementTerm(viewId);
    const predicates = [...new Set(types.map(t => t.r.path))];
    const counts = new Map(dir === 'out' ? rows(g, `SELECT ?p (COUNT(DISTINCT ?o) AS ?n) WHERE {
        VALUES ?p { ${predicates.map(iri).join(' ')} }
        GRAPH ?lg { ${F} ?p ?o } FILTER (?lg != ${NOT_REPORT})
    } GROUP BY ?p`).map(r => [r.p.value, Number(r.n.value)]) : []);
    const words = text?.trim().toLowerCase();

    const sections = types.map(({ r, other }): LinkSection => {
        const cls = meta.classes.find(c => c.iri === other);
        const set = dir === 'out' && r.valueSet ? Object.values(shapes.valueSets).find(v => v.uri === r.valueSet) : undefined;
        const otherName = set ? `${set.label} concept` : cls?.name ?? other.replace(/^.*[#/]/, '');
        const card = r.maxCount !== undefined || r.minCount !== undefined ? ` [${r.minCount ?? 0}..${r.maxCount ?? '*'}]` : '';
        const reached = dir === 'out' && r.maxCount !== undefined && (counts.get(r.path) ?? 0) >= r.maxCount ? ' — maximum reached' : '';
        const P = iri(r.path);
        const found = construct(g, `CONSTRUCT { ?s rdf:type ?type . ?pl view:element ?s } WHERE {
            { ${things()} }
            FILTER (${other === ANY_RESOURCE ? '' : `?type = ${iri(other)} && `}?s != ${F})
            ${dir === 'out' && r.values ? r.values.length ? `FILTER (?s IN (${r.values.map(iri).join(', ')}))` : 'FILTER (false)' : ''}
            FILTER NOT EXISTS { GRAPH ?linked { ${dir === 'out' ? `${F} ${P} ?s` : `?s ${P} ${F}`} } FILTER (?linked != ${NOT_REPORT}) }
            OPTIONAL { GRAPH ${view ? iri(view.value) : '<urn:trellis:no-view>'} { ?pl view:element ?s } }
        }`);
        const subjects = [...new Set(found.filter(q => q.predicate.value === NS.rdf + 'type').map(q => q.subject.value))];
        const placed = new Set(found.filter(q => q.predicate.value === NS.view + 'element').map(q => q.object.value));
        const names = labels(g, subjects);
        const full = dir === 'in' && r.maxCount !== undefined ? new Set(rows(g, `SELECT ?candidate WHERE {
            VALUES ?candidate { ${subjects.map(iri).join(' ')} }
            GRAPH ?lg { ?candidate ${P} ?o } FILTER (?lg != ${NOT_REPORT})
        } GROUP BY ?candidate HAVING (COUNT(DISTINCT ?o) >= ${r.maxCount})`).map(x => x.candidate.value)) : new Set<string>();
        const eligible = subjects.filter(s => !(dir === 'in' && r.maxCount === 0) && !full.has(s) && (!words || names.get(s)!.toLowerCase().includes(words)))
            .sort((a, b) => Number(placed.has(b)) - Number(placed.has(a)) || compareLabels(names.get(a)!, names.get(b)!) || a.localeCompare(b));
        const candidates = eligible.slice(0, LINK_LIMIT).map(s => ({
            id: elementId(rdf.namedNode(s)), label: names.get(s)!, description: placed.has(s) ? r.name : `${r.name} · add to view`
        }));
        const creator = dir === 'out' ? `${r.name} → new ${otherName}` : `new ${otherName} → ${r.name}`;
        const create = set?.kind === 'scheme' && dir === 'out'
            ? { classIri: other, scheme: set.uri, label: freeUnnamedLabel(g, 'concept'), item: `+ New ${otherName}`, creator }
            : set || !cls ? undefined : { classIri: other, label: freeUnnamedLabel(g, instanceNoun(cls)), item: `+ New ${otherName}`, creator };
        return {
            header: dir === 'out' ? `${r.name} → ${otherName}${card}${reached}` : `${otherName} → ${r.name}${card}`,
            predicate: r.path, name: r.name, candidates, ...(eligible.length > candidates.length ? { more: eligible.length - candidates.length } : {}), create
        };
    });
    return { title: `${self.label} (${name}): pick ${dir === 'out' ? 'a target' : 'a source'}, or type a name to create one`, sections };
}
