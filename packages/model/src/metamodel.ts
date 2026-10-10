// Metamodel: palette classes, fields and relation types, as JSON. Built from SHACL shapes by @catenary/rdf, with the schema rules of
// the schema providers (RDFS) merged in (mergeSchema).

import type { Schema } from '@catenary/schema';
import { NS, TermJSON, localName } from './terms';
import { compactParts, shortIri } from './shapes-doc';

export interface FieldDef {
    path: string;
    name: string;
    description?: string;
    datatype?: string;
    iri: boolean;                // values are IRIs (sh:nodeKind sh:IRI), not literals
    in?: TermJSON[];             // sh:in
    minCount?: number;
    maxCount?: number;
    order?: number;
    /** The schema provider of the field (`rdfs`). None: the shapes. */
    source?: string;
}

export interface RelationDef {
    path: string;
    name: string;
    description?: string;
    targetClass: string;
    /** A concept scheme or collection as target (targetClass skos:Concept): its IRI, and the allowed objects (its concepts or members). */
    valueSet?: string;
    values?: string[];
    minCount?: number;
    maxCount?: number;
    order?: number;
    /** The schema provider of the relation (`rdfs`). None: the shapes. */
    source?: string;
}

export interface ClassDef {
    iri: string;
    name: string;                // rdfs:label or skos:prefLabel of the class, else shortIri ("dcat:Dataset"). Not the name of a shape.
    description?: string;
    shapes: string[];            // shape ids (IRI or blank node label)
    fields: FieldDef[];
    relations: RelationDef[];
    unsupported: string[];       // human readable notes, for example "inverse path"
    color: string;               // JSON Canvas preset color, by palette position
    labelInShape: boolean;       // a property shape has sh:path rdfs:label (the form edits the label)
    order?: number;
}

/** A skos:ConceptScheme of the data file or of the shapes files. */
export interface SchemeDef {
    iri: string;
    label: string;
    description?: string;
}

/** A skos:Concept of the data file or of the shapes files. */
export interface ConceptDef {
    iri: string;
    label: string;               // skos:prefLabel, else rdfs:label, else local name
    notation?: string;
    definition?: string;
    schemes: string[];           // skos:inScheme, skos:topConceptOf, skos:hasTopConcept (inverse)
    broader: string[];           // skos:broader, skos:narrower (inverse)
    top: boolean;                // skos:topConceptOf or skos:hasTopConcept
}

/** The part of the metamodel that the queries below and the frontend use. */
export interface Classes {
    classes: ClassDef[];
    schemes?: SchemeDef[];
    concepts?: ConceptDef[];
}

/** The target class of a relation to any resource (an RDFS rule without a class range): it admits an instance of any class. */
export const ANY_RESOURCE = NS.rdfs + 'Resource';

/** The relation admits an instance with `types`. */
const admits = (r: RelationDef, types: string[]) => r.targetClass === ANY_RESOURCE || types.includes(r.targetClass);

/** JSON Canvas preset colors of the classes, by palette position. */
export const CLASS_COLORS = ['6', '4', '5', '2', '3', '1'];

/** Fields and relations: by sh:order, then by name. */
export function byOrderThenName(a: { order?: number; name: string }, b: { order?: number; name: string }): number {
    return (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name);
}

/**
 * The metamodel with the rules of a schema provider (`source`) added. The shapes win: a rule for a predicate that the shapes already
 * describe on its class adds nothing. A class that only the rules know is added after the classes of the shapes, ordered by name.
 * A class range gives a relation. Literal ranges of one predicate give one field (a datatype only when all ranges have the same one).
 * Any value gives a field without a datatype and a relation to any resource (ANY_RESOURCE).
 */
export function mergeSchema<T extends Classes>(meta: T, schema: Schema, source: string): T {
    if (!schema.rules.length) return meta;
    const byIri = new Map(meta.classes.map(c => [c.iri, c]));
    const shaped = new Map(meta.classes.map(c => [c.iri, new Set([...c.fields, ...c.relations].map(x => x.path))]));
    const touched = new Map<string, ClassDef>(), added: ClassDef[] = [];
    const datatypes = new Map<string, Set<string | undefined>>();
    for (const rule of schema.rules) {
        if (shaped.get(rule.domain)?.has(rule.predicate)) continue;
        let def = touched.get(rule.domain);
        if (!def) {
            const own = byIri.get(rule.domain);
            const info = schema.classes[rule.domain];
            def = own ? { ...own, fields: [...own.fields], relations: [...own.relations] }
                : { iri: rule.domain, name: info?.name ?? shortIri(rule.domain), ...(info?.description ? { description: info.description } : {}),
                    shapes: [], fields: [], relations: [], unsupported: [], color: '', labelInShape: false };
            if (!own) added.push(def);
            touched.set(rule.domain, def);
        }
        const common = { path: rule.predicate, name: rule.name ?? localName(rule.predicate), ...(rule.description ? { description: rule.description } : {}), source };
        if (rule.range.kind !== 'literal') {
            const targetClass = rule.range.kind === 'class' ? rule.range.iri : ANY_RESOURCE;
            if (!def.relations.some(r => r.path === rule.predicate && r.targetClass === targetClass)) def.relations.push({ ...common, targetClass });
            if (rule.range.kind === 'class') continue;
        }
        const key = rule.domain + ' ' + rule.predicate;
        const seen = datatypes.get(key) ?? new Set();
        const given = rule.range.kind === 'literal' ? rule.range.datatype : undefined;
        seen.add(given);
        datatypes.set(key, seen);
        const datatype = seen.size === 1 ? given : undefined;
        const field = def.fields.find(f => f.path === rule.predicate && f.source === source);
        if (field) { if (datatype === undefined) delete field.datatype; }
        else def.fields.push({ ...common, ...(datatype ? { datatype } : {}), iri: false });
    }
    for (const def of touched.values()) {
        def.fields.sort(byOrderThenName);
        def.relations.sort(byOrderThenName);
    }
    added.sort((a, b) => a.name.localeCompare(b.name) || a.iri.localeCompare(b.iri));
    const n = meta.classes.length;
    added.forEach((c, i) => { c.color = CLASS_COLORS[(n + i) % CLASS_COLORS.length]; });
    return { ...meta, classes: [...meta.classes.map(c => touched.get(c.iri) ?? c), ...added] };
}

// ---- Queries used by the UI and by the operations ----

/** Noun for new instances of a class: the name without "prefix:", camel case split ("dprod:DataProduct" -> "Data Product"). */
export function instanceNoun(cls: ClassDef): string {
    return cls.name.replace(/^[A-Za-z][\w-]*:(?=\S)/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export function classDef(meta: Classes, iri: string): ClassDef | undefined {
    return meta.classes.find(c => c.iri === iri);
}

/** The metamodel class of an instance: its first type that the shapes know. */
export function primaryClass(meta: Classes, types: string[]): ClassDef | undefined {
    for (const t of types) {
        const c = classDef(meta, t);
        if (c) return c;
    }
    return undefined;
}

/** The class ranges of the schema rules (not the shapes) of an instance with `types`: the classes of its link candidates. */
export function schemaRanges(meta: Classes, types: string[]): string[] {
    return [...new Set(types.flatMap(t => (classDef(meta, t)?.relations ?? []).filter(r => r.source && r.targetClass !== ANY_RESOURCE).map(r => r.targetClass)))].sort();
}

/** The class of the views (each view graph has `<view> a view:View`). */
export const VIEW_CLASS = NS.view + 'View';

/** Relation types the metamodel (shapes and schema rules) permits from an instance with `from` types to one with `to` types (and IRI `toIri`: see RelationDef.values). */
export function permittedRelations(meta: Classes, from: string[], to: string[], toIri?: string): RelationDef[] {
    const result: RelationDef[] = [];
    const seen = new Set<string>();
    for (const t of from) {
        for (const r of classDef(meta, t)?.relations ?? []) {
            if (admits(r, to) && (!r.values || toIri === undefined || r.values.includes(toIri)) && !seen.has(r.path)) {
                seen.add(r.path);
                result.push(r);
            }
        }
    }
    return result;
}

/** Relation types the shapes declare for an instance with `from` types, in shape order. */
export function outgoingRelations(meta: Classes, from: string[]): RelationDef[] {
    const result: RelationDef[] = [];
    for (const t of from) {
        for (const r of classDef(meta, t)?.relations ?? []) {
            if (!result.some(x => x.path === r.path && x.targetClass === r.targetClass)) result.push(r);
        }
    }
    return result;
}

/** Label for a predicate: configured prefix and local name, else sh:name or its short IRI (including decoded urn:name labels). */
export function predicateName(meta: Classes, predicate: string): string {
    const compact = compactParts(predicate);
    if (compact) return `${compact.prefix}:${compact.local}`;
    for (const c of meta.classes) {
        const hit = c.relations.find(r => r.path === predicate) ?? c.fields.find(f => f.path === predicate);
        if (hit) return hit.name === localName(predicate) ? shortIri(predicate) : hit.name;
    }
    return shortIri(predicate);
}
