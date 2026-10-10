// The RDFS providers of the palette, links and fields contracts. A predicate with `rdfs:domain C` applies to the instances of C and of
// its written subclasses. Its `rdfs:range` says what its objects are: instances of a class and of its written subclasses (a link), or
// literals (a field). Several domains or ranges are a union: an editor suggestion, not the intersection of RDFS semantics. No range,
// rdfs:Resource and owl:Thing: any value, a literal or a resource (a field and a link). rdfs:Literal: any literal. No inference of
// types, no rdfs:subPropertyOf, no cardinality, no validation.

import type { FieldRule, FieldsProvider } from '@catenary/fields';
import type { LinkRule, LinksProvider } from '@catenary/links';
import type { PaletteClass, PaletteProvider } from '@catenary/palette';
import { OWL, QueryPort, RDF, RDFS, SH, XSD, iri } from '@catenary/query';

/** What the objects of a predicate are: instances of a class, literals (of a datatype), or any value (a literal or a resource). */
export type RdfsRange = { kind: 'class'; iri: string } | { kind: 'literal'; datatype?: string } | { kind: 'any' };
/** One domain, predicate and range, after the expansion to the written subclasses. */
export interface RdfsRule { domain: string; predicate: string; name?: string; description?: string; range: RdfsRange }
export interface RdfsRules { rules: RdfsRule[]; classes: Record<string, { name?: string; description?: string }> }

const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const PREFIXES = `PREFIX rdf: <${RDF}> PREFIX rdfs: <${RDFS}> PREFIX skos: <${SKOS}>`;

/** Built-in vocabularies: their predicates and classes give no rules (the editor handles them itself). */
const BUILT_IN = [RDF, RDFS, OWL, SH, SKOS];
/** Ranges that accept any value: a literal or a resource. */
const ANY = new Set([RDFS + 'Resource', OWL + 'Thing']);
/** Literal ranges outside the XSD namespace. */
const LITERALS = new Set([RDF + 'langString', RDF + 'HTML', RDF + 'XMLLiteral', RDF + 'JSON', RDF + 'PlainLiteral']);

const builtIn = (iri: string) => BUILT_IN.some(ns => iri.startsWith(ns));

const add = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (!list) m.set(k, [v]);
    else if (!list.includes(v)) list.push(v);
};

/** A class and its written subclasses at any depth, the class first. A subclass cycle ends. */
function withSubclasses(subs: Map<string, string[]>, c: string): string[] {
    const out: string[] = [];
    const visit = (x: string) => {
        if (out.includes(x)) return;
        out.push(x);
        (subs.get(x) ?? []).slice().sort().forEach(visit);
    };
    visit(c);
    return out;
}

/** A plain or English literal first, then the others in value order. */
function texts(port: QueryPort, predicates: string, subjects: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (!subjects.length) return out;
    const found = port.select(`${PREFIXES} SELECT ?s ?v ?lang WHERE {
        VALUES ?s { ${subjects.map(iri).join(' ')} }
        ${port.graph(`?s ${predicates} ?v`)} FILTER (isLiteral(?v)) BIND (LANG(?v) AS ?lang)
    }`);
    const rank = (r: typeof found[number]) => (!r.lang?.value || r.lang.value.startsWith('en') ? 0 : 1);
    for (const r of [...found].sort((a, b) => rank(a) - rank(b) || a.v.value.localeCompare(b.v.value))) if (!out.has(r.s.value)) out.set(r.s.value, r.v.value);
    return out;
}

/** The range of one `rdfs:range` value: any value, any literal, a literal of a datatype, or a class. */
function rangeOf(r: string, datatypes: Set<string>): RdfsRange {
    if (ANY.has(r)) return { kind: 'any' };
    if (r === RDFS + 'Literal') return { kind: 'literal' };
    if (r.startsWith(XSD) || LITERALS.has(r) || datatypes.has(r)) return { kind: 'literal', datatype: r };
    return { kind: 'class', iri: r };
}

/** The rules of the written rdfs:domain and rdfs:range statements of the files. */
export function rdfsRules(port: QueryPort): RdfsRules {
    const iriPairs = (pattern: string) => port.select(`${PREFIXES} SELECT DISTINCT ?a ?b WHERE { ${port.graph(pattern)} FILTER (isIRI(?a) && isIRI(?b)) }`);
    const domains = new Map<string, string[]>(), ranges = new Map<string, string[]>(), subs = new Map<string, string[]>();
    for (const r of iriPairs('?a rdfs:domain ?b')) if (!builtIn(r.a.value) && !builtIn(r.b.value)) add(domains, r.a.value, r.b.value);
    if (!domains.size) return { rules: [], classes: {} };
    for (const r of iriPairs('?a rdfs:range ?b')) if (domains.has(r.a.value)) add(ranges, r.a.value, r.b.value);
    for (const r of iriPairs('?a rdfs:subClassOf ?b')) if (r.a.value !== r.b.value) add(subs, r.b.value, r.a.value);
    const datatypes = new Set(port.select(`${PREFIXES} SELECT DISTINCT ?t WHERE { ${port.graph('?t rdf:type rdfs:Datatype')} FILTER (isIRI(?t)) }`).map(r => r.t.value));

    const predicates = [...domains.keys()].sort();
    const names = texts(port, 'rdfs:label|skos:prefLabel', predicates), comments = texts(port, 'rdfs:comment', predicates);
    const rules: RdfsRule[] = [], seen = new Set<string>();
    for (const p of predicates) {
        const objects = (ranges.get(p) ?? []).slice().sort().map(r => rangeOf(r, datatypes));
        // A class range also admits the instances of its subclasses: one relation for each, as permittedRelations matches types.
        const expanded: RdfsRange[] = objects.length ? objects.flatMap((r): RdfsRange[] => r.kind === 'class' ? withSubclasses(subs, r.iri).map(c => ({ kind: 'class', iri: c })) : [r])
            : [{ kind: 'any' }];
        const own = { predicate: p, ...(names.has(p) ? { name: names.get(p) } : {}), ...(comments.has(p) ? { description: comments.get(p) } : {}) };
        const classes = [...new Set(domains.get(p)!.slice().sort().flatMap(d => withSubclasses(subs, d)))];
        for (const domain of classes) for (const range of expanded) {
            const key = JSON.stringify([domain, p, range]);
            if (!seen.has(key)) rules.push({ domain, ...own, range });
            seen.add(key);
        }
    }

    const classIris = [...new Set(rules.flatMap(r => [r.domain, ...(r.range.kind === 'class' ? [r.range.iri] : [])]))].sort();
    const classNames = texts(port, 'rdfs:label|skos:prefLabel', classIris), classComments = texts(port, 'rdfs:comment', classIris);
    const classes: RdfsRules['classes'] = {};
    for (const c of classIris) classes[c] = { ...(classNames.has(c) ? { name: classNames.get(c) } : {}), ...(classComments.has(c) ? { description: classComments.get(c) } : {}) };
    return { rules, classes };
}


const read = new WeakMap<QueryPort, RdfsRules>();
const rulesOf = (port: QueryPort) => {
    let r = read.get(port);
    if (!r) read.set(port, r = rdfsRules(port));
    return r;
};

/** The domains of the rules, with their written labels and descriptions; in IRI order. */
function classes(port: QueryPort): PaletteClass[] {
    const { rules, classes } = rulesOf(port);
    return [...new Set(rules.map(r => r.domain))].sort().map(iri => ({ iri, ...classes[iri] }));
}

const own = (r: RdfsRule) => ({ domain: r.domain, predicate: r.predicate, ...(r.name ? { name: r.name } : {}), ...(r.description ? { description: r.description } : {}) });

/** A class range: a link to that class. Any value: a link to any resource (and a field). */
function links(port: QueryPort): LinkRule[] {
    return rulesOf(port).rules.flatMap(r => r.range.kind === 'class' ? [{ ...own(r), target: r.range.iri }] : r.range.kind === 'any' ? [own(r)] : []);
}

/** Literal ranges and any value: one field for each domain and predicate, with a datatype only when all its ranges have the same one. */
function fields(port: QueryPort): FieldRule[] {
    const out = new Map<string, { field: FieldRule; datatypes: Set<string | undefined> }>();
    for (const r of rulesOf(port).rules) {
        if (r.range.kind === 'class') continue;
        const k = r.domain + ' ' + r.predicate;
        const entry = out.get(k) ?? { field: own(r), datatypes: new Set() };
        out.set(k, entry);
        entry.datatypes.add(r.range.kind === 'literal' ? r.range.datatype : undefined);
    }
    return [...out.values()].map(({ field, datatypes }) => {
        const [datatype] = datatypes;
        return { ...field, ...(datatypes.size === 1 && datatype ? { datatype } : {}), iri: false };
    });
}

export const rdfsPalette: PaletteProvider = { id: 'rdfs', classes };
export const rdfsLinks: LinksProvider = { id: 'rdfs', links };
export const rdfsFields: FieldsProvider = { id: 'rdfs', fields };
