// Metamodel: palette classes, fields and relation types, as JSON. Merged from what the vocabulary plugins (SHACL, RDFS) give the
// palette, links and fields contracts (mergeContributions); @catenary/rdf runs the plugins.

import type { FieldRule } from '@catenary/fields';
import type { LinkRule } from '@catenary/links';
import type { PaletteClass } from '@catenary/palette';
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
    /** The plugin of the field (`rdfs`). None: the shapes (SHAPES_SOURCE). */
    source?: string;
}

export interface RelationDef {
    path: string;
    name: string;
    description?: string;
    targetClass: string;
    /** Classes whose instances also count as an instance of `targetClass` (RDFS: its written subclasses). */
    targetSubclasses?: string[];
    /** A concept scheme or collection as target (targetClass skos:Concept): its IRI, and the allowed objects (its concepts or members). */
    valueSet?: string;
    values?: string[];
    minCount?: number;
    maxCount?: number;
    order?: number;
    /** The plugin of the relation (`rdfs`). None: the shapes (SHAPES_SOURCE). */
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

/** The relation admits an instance with `types`: of its target class, of a subclass that it names, or any resource. */
export const relationAdmits = (r: RelationDef, types: readonly string[]) =>
    r.targetClass === ANY_RESOURCE || types.includes(r.targetClass) || (r.targetSubclasses ?? []).some(c => types.includes(c));

/** JSON Canvas preset colors of the classes, by palette position. */
export const CLASS_COLORS = ['6', '4', '5', '2', '3', '1'];

/** Fields and relations: by sh:order, then by name. */
export function byOrderThenName(a: { order?: number; name: string }, b: { order?: number; name: string }): number {
    return (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name);
}

/** The plugin whose fields and links are its own shapes: the form shows its shapes, not form shapes of the metamodel. No `source`. */
export const SHAPES_SOURCE = 'shacl';

/** What one vocabulary plugin gave the palette, links and fields contracts. */
export interface PluginContributions {
    id: string;
    classes?: PaletteClass[];
    links?: LinkRule[];
    fields?: FieldRule[];
}

/**
 * The metamodel of the plugins, in precedence order (SHACL first). Classes: the first plugin that gives a class wins; the classes of a
 * plugin go after those of the plugins before it, by order, then name. Links and fields: for a class and a predicate, the first plugin
 * that gives a link or a field wins. A field of rdfs:label makes the label editable (`labelInShape`). A link without a target admits
 * any resource (ANY_RESOURCE). A value set without values: the concepts of the scheme, from `vocabulary`.
 */
export function mergeContributions(plugins: readonly PluginContributions[], vocabulary: Pick<Classes, 'schemes' | 'concepts'> = {}): Classes {
    const classes: ClassDef[] = [], byIri = new Map<string, ClassDef>();
    const owned = new Set<string>();
    for (const plugin of plugins) {
        const block: ClassDef[] = [];
        for (const c of plugin.classes ?? []) {
            if (byIri.has(c.iri) || block.some(b => b.iri === c.iri)) continue;
            block.push({
                iri: c.iri, name: c.name ?? shortIri(c.iri), ...(c.description !== undefined ? { description: c.description } : {}),
                shapes: c.sources ?? [], fields: [], relations: [], unsupported: c.notes ?? [], color: '', labelInShape: false,
                ...(c.order !== undefined ? { order: c.order } : {})
            });
        }
        block.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name));
        for (const c of block) { classes.push(c); byIri.set(c.iri, c); }

        const source = plugin.id === SHAPES_SOURCE ? {} : { source: plugin.id };
        const claimed = new Set<string>();
        const target = (rule: { domain: string; predicate: string }) => {
            const k = rule.domain + ' ' + rule.predicate;
            if (owned.has(k)) return undefined;
            claimed.add(k);
            return byIri.get(rule.domain);
        };
        const common = (r: FieldRule | LinkRule) => ({
            path: r.predicate, name: r.name ?? localName(r.predicate), description: r.description, minCount: r.minCount, maxCount: r.maxCount, order: r.order, ...source
        });
        for (const f of plugin.fields ?? []) {
            const cls = target(f);
            if (!cls) continue;
            if (f.predicate === NS.rdfs + 'label') cls.labelInShape = true;
            else cls.fields.push({ ...common(f), datatype: f.datatype, iri: f.iri ?? false, in: f.in });
        }
        for (const l of plugin.links ?? []) {
            const cls = target(l);
            if (!cls) continue;
            const values = l.valueSet && (l.valueSet.values ?? (vocabulary.concepts ?? []).filter(c => c.schemes.includes(l.valueSet!.iri)).map(c => c.iri));
            cls.relations.push({ ...common(l), targetClass: l.target ?? ANY_RESOURCE, ...(l.target && l.targetSubclasses?.length ? { targetSubclasses: l.targetSubclasses } : {}), ...(l.valueSet ? { valueSet: l.valueSet.iri, values } : {}) });
        }
        for (const k of claimed) owned.add(k);
    }
    for (const c of classes) {
        c.fields.sort(byOrderThenName);
        c.relations.sort(byOrderThenName);
    }
    classes.forEach((c, i) => { c.color = CLASS_COLORS[i % CLASS_COLORS.length]; });
    return { classes, ...vocabulary };
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

/** The class ranges of the links of the plugins other than the shapes (RDFS) of an instance with `types`: the classes of its link candidates. */
export function pluginRanges(meta: Classes, types: string[]): string[] {
    return [...new Set(types.flatMap(t => (classDef(meta, t)?.relations ?? []).filter(r => r.source && r.targetClass !== ANY_RESOURCE).flatMap(r => [r.targetClass, ...r.targetSubclasses ?? []])))].sort();
}

/** The class of the views (each view graph has `<view> a view:View`). */
export const VIEW_CLASS = NS.view + 'View';

/** Relation types the metamodel (shapes and plugin rules) permits from an instance with `from` types to one with `to` types (and IRI `toIri`: see RelationDef.values). */
export function permittedRelations(meta: Classes, from: string[], to: string[], toIri?: string): RelationDef[] {
    const result: RelationDef[] = [];
    const seen = new Set<string>();
    for (const t of from) {
        for (const r of classDef(meta, t)?.relations ?? []) {
            if (relationAdmits(r, to) && (!r.values || toIri === undefined || r.values.includes(toIri)) && !seen.has(r.path)) {
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
