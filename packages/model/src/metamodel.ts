// Metamodel: palette classes, fields and relation types, as JSON. Built from SHACL shapes by @catenary/rdf.

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

/** The class of the views (each view graph has `<view> a view:View`). A class folder of the Model explorer, with the views. */
export const VIEW_CLASS = NS.view + 'View';

/**
 * The top rows of a concept tree: by folder key, 'scheme:<iri>' or 'no-scheme'. The other concepts are rows under their broader concepts.
 * In a scheme: the top concepts and the concepts with no broader concept in the scheme. No scheme: concepts with no scheme and no known broader concept.
 * A concept that no row reaches (a broader cycle) is also a top row: of its first scheme, else of No scheme. So each concept has a row.
 */
export function conceptRoots(concepts: ConceptDef[]): Map<string, ConceptDef[]> {
    const byIri = new Map(concepts.map(c => [c.iri, c]));
    const roots = new Map<string, ConceptDef[]>();
    const add = (key: string, c: ConceptDef) => roots.set(key, [...roots.get(key) ?? [], c]);
    for (const c of concepts) {
        if (!c.schemes.length && !c.broader.some(b => byIri.has(b))) add('no-scheme', c);
        for (const s of c.schemes) if (c.top || !c.broader.some(b => byIri.get(b)?.schemes.includes(s))) add('scheme:' + s, c);
    }
    const reached = new Set<string>();
    const reach = (c: ConceptDef) => {
        if (reached.has(c.iri)) return;
        reached.add(c.iri);
        concepts.filter(x => x.broader.includes(c.iri)).forEach(reach);
    };
    [...roots.values()].flat().forEach(reach);
    for (const c of concepts) {
        if (reached.has(c.iri)) continue;
        add(c.schemes.length ? 'scheme:' + c.schemes[0] : 'no-scheme', c);
        reach(c);
    }
    return roots;
}

/** The first row of concept `iri` in the tree of `conceptRoots`: folder key and the broader concepts from the top row down. Undefined: not a concept. */
export function conceptPath(concepts: ConceptDef[], iri: string): { folder: string; broader: string[] } | undefined {
    const narrower = (c: string) => concepts.filter(x => x.broader.includes(c)).map(x => x.iri);
    for (const [folder, top] of conceptRoots(concepts)) {
        // Breadth first from the top rows; a path does not repeat a concept.
        const queue: string[][] = top.map(c => [c.iri]);
        while (queue.length) {
            const path = queue.shift()!;
            const last = path[path.length - 1];
            if (last === iri) return { folder, broader: path.slice(0, -1) };
            for (const n of narrower(last)) if (!path.includes(n)) queue.push([...path, n]);
        }
    }
    return undefined;
}

/** Relation types the shapes permit from an instance with `from` types to one with `to` types (and IRI `toIri`: see RelationDef.values). */
export function permittedRelations(meta: Classes, from: string[], to: string[], toIri?: string): RelationDef[] {
    const result: RelationDef[] = [];
    const seen = new Set<string>();
    for (const t of from) {
        for (const r of classDef(meta, t)?.relations ?? []) {
            if (to.includes(r.targetClass) && (!r.values || toIri === undefined || r.values.includes(toIri)) && !seen.has(r.path)) {
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
