// Read model of the shapes files: node shapes, property shapes and logical constraints, as plain JSON. @catenary/rdf derives it
// from the shapes graphs. Also the pure parts of the shape editor: prefixes, property paths as text, cardinality, verbalization.
// Ids (see @catenary/rdf ids.ts): node shape, property shape, concept scheme and collection n-<iri>; logical constraint
// c-<op>-<shape>-<n>. The shapes graphs have no blank nodes (except path expressions); a property shape read from a blank node (only
// before the blank nodes are replaced) has the id p-<shape>-<path>-<range>.

import { nameFromURI, nameToURI } from 'canonical-md';
import { NS, TermJSON, localName } from './terms';

/** A SHACL property path. `unsupported`: zero-or-more and the other repetition paths; shown as text, kept in the file. */
export type PathJSON =
    | { kind: 'iri'; iri: string }
    | { kind: 'inverse'; path: PathJSON }
    | { kind: 'sequence'; items: PathJSON[] }
    | { kind: 'alternative'; items: PathJSON[] }
    | { kind: 'unsupported'; text: string };

export const NODE_KINDS = ['IRI', 'Literal', 'BlankNode', 'BlankNodeOrIRI', 'BlankNodeOrLiteral', 'IRIOrLiteral'] as const;
export type NodeKind = typeof NODE_KINDS[number];

/** What the values of a property shape are. The canvas draws one target for each property shape. */
export type Range =
    | { kind: 'node'; shape: string }          // sh:node, a node shape (id)
    | { kind: 'class'; class: string }         // sh:class
    | { kind: 'datatype'; datatype: string }
    | { kind: 'nodeKind'; nodeKind: NodeKind }
    | { kind: 'in'; values: TermJSON[] }
    | { kind: 'scheme'; schemes: string[] }    // skos:Concept in one of these schemes (sh:node to a shape with skos:inScheme)
    | { kind: 'collection'; collection: string } // a member of a skos:Collection (sh:node to a shape with sh:in of the members)
    | { kind: 'or'; alternatives: SimpleRange[] } // sh:or of shapes that each have one range: a value matches one of them
    | { kind: 'any' };

/** A range that is not an "or" and not "any": an alternative of an "or" range. */
export type SimpleRange = Exclude<Range, { kind: 'or' } | { kind: 'any' }>;

/** An "or" range with one alternative is that alternative; with none, "any". */
export function orRange(alternatives: SimpleRange[]): Range {
    const unique = alternatives.filter((a, i) => alternatives.findIndex(b => rangeKey(b) === rangeKey(a)) === i);
    return unique.length === 0 ? { kind: 'any' } : unique.length === 1 ? unique[0] : { kind: 'or', alternatives: unique };
}

/** The alternatives of a range: its own for "or", else the range itself ("any": none). */
export function alternativesOf(r: Range): SimpleRange[] {
    return r.kind === 'or' ? r.alternatives : r.kind === 'any' ? [] : [r];
}

/** Stable text of a range (ids and comparisons). */
export function rangeKey(r: Range): string {
    switch (r.kind) {
        case 'node': return 'node:' + r.shape;
        case 'class': return 'class:' + r.class;
        case 'datatype': return 'datatype:' + r.datatype;
        case 'nodeKind': return 'nodeKind:' + r.nodeKind;
        case 'in': return 'in:' + r.values.map(v => v.value).join(' ');
        case 'scheme': return 'scheme:' + r.schemes.join(' ');
        case 'collection': return 'collection:' + r.collection;
        case 'or': return 'or:' + r.alternatives.map(rangeKey).join('|');
        case 'any': return 'any';
    }
}

/** A SKOS concept scheme or collection of the shapes files: the target node of a property with a value set. */
export interface ValueSet {
    id: string;
    uri: string;
    kind: 'scheme' | 'collection';
    /** skos:prefLabel (no language or English first), else rdfs:label, else the local name. */
    label: string;
    file: string;
    /** Concepts: in a scheme skos:inScheme (or skos:hasTopConcept); in a collection skos:member. By label. */
    members: { uri: string; label: string; broader?: string[] }[];
}

export type LogicalOperator = 'or' | 'xone' | 'and' | 'not';
export const LOGICAL_OPERATORS: LogicalOperator[] = ['or', 'xone', 'and', 'not'];

export interface NodeShape {
    id: string;
    uri: string;
    label: string;                  // sh:name, else rdfs:label, else the local name
    targetClass?: string;
    /** Predicates of sh:targetSubjectsOf. Any matching predicate selects a subject. */
    targetSubjectsOf?: string[];
    closed?: boolean;
    description?: string;
    /** Shapes file that holds the shape (absolute path, or the graph IRI when unknown). */
    file: string;
    /** Property shapes: sh:property and the members of logical constraints, in id order. */
    properties: string[];
    constraints: string[];
    /** Statements that the editor does not map, as "predicate object" text. They stay in the file. */
    raw: string[];
}

export interface PropertyShape {
    id: string;
    /** IRI of the property shape (undefined: a blank node, before the blank nodes are replaced). */
    uri?: string;
    owner: string;                  // node shape id
    /** Logical constraint that holds it (a list member), else it is an sh:property of the owner. */
    constraint?: string;
    path: PathJSON;
    name?: string;
    description?: string;
    minCount?: number;
    maxCount?: number;
    range: Range;
    /** sh:nodeKind next to another range (for example IRI with sh:class). */
    nodeKind?: NodeKind;
    /** sh:node that is not a node shape of the shapes files (IRI), or an inline shape. */
    nodeRef?: string;
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    languageIn?: string[];
    order?: number;
    raw: string[];
}

export interface LogicalConstraint {
    id: string;
    owner: string;
    operator: LogicalOperator;
    members: string[];
    /** List members that are not property shapes (no sh:path), as text. */
    raw: string[];
}

export interface ShapesModel {
    nodeShapes: Record<string, NodeShape>;
    properties: Record<string, PropertyShape>;
    constraints: Record<string, LogicalConstraint>;
    valueSets: Record<string, ValueSet>;
}

export function emptyShapes(): ShapesModel {
    return { nodeShapes: {}, properties: {}, constraints: {}, valueSets: {} };
}

/** The range of a node shape card (its target class, else sh:node) or a value set card. */
export function rangeOfShape(shapes: ShapesModel, id: string): Range | undefined {
    const shape = shapes.nodeShapes[id];
    if (shape) return shape.targetClass ? { kind: 'class', class: shape.targetClass } : { kind: 'node', shape: id };
    const set = shapes.valueSets[id];
    if (set) return set.kind === 'scheme' ? { kind: 'scheme', schemes: [set.uri] } : { kind: 'collection', collection: set.uri };
    return undefined;
}

/** The value set (id) that a range points to, if any. */
export function valueSetOf(shapes: ShapesModel, r: Range): string | undefined {
    const uri = r.kind === 'scheme' && r.schemes.length === 1 ? r.schemes[0] : r.kind === 'collection' ? r.collection : undefined;
    return uri ? Object.values(shapes.valueSets).find(v => v.uri === uri)?.id : undefined;
}

/**
 * A data change that a shape edit asks for (the patch queue). The store keeps the queue; the user applies (one undo step) or
 * dismisses each entry. `count`: statements of the data that the migration changes now.
 */
export type Migration = { id: string; count: number; reason: string } & MigrationChange;
export type MigrationChange =
    /** Replace the predicate `from` by `to` in the statements of the instances of `classIri` (all subjects without a class). */
    | { kind: 'renamePredicate'; classIri?: string; from: string; to: string }
    /** Replace the rdf:type `from` by `to`. */
    | { kind: 'renameClass'; from: string; to: string };

// ------------------------------------------------------------------ prefixes

/**
 * Default prefixes: the prefix table of a new workspace, and of a workspace file without prefix declarations. A workspace file stores
 * its table (sh:declare in the manifest graph); the user edits it with the Prefixes editor.
 */
export const DEFAULT_PREFIXES: Readonly<Record<string, string>> = {
    adms: 'http://www.w3.org/ns/adms#',
    dcat: 'http://www.w3.org/ns/dcat#',
    dct: NS.dct,
    dpm: 'osg://vocab/data-product-draft#',
    dprod: 'https://ekgf.github.io/dprod/',
    foaf: 'http://xmlns.com/foaf/0.1/',
    locn: 'http://www.w3.org/ns/locn#',
    odrl: 'http://www.w3.org/ns/odrl/2/',
    org: 'http://www.w3.org/ns/org#',
    owl: NS.owl,
    prov: 'http://www.w3.org/ns/prov#',
    rdf: NS.rdf,
    rdfs: NS.rdfs,
    schema: 'https://schema.org/',
    sh: NS.sh,
    skos: NS.skos,
    time: 'http://www.w3.org/2006/time#',
    vann: 'http://purl.org/vocab/vann/',
    vcard: 'http://www.w3.org/2006/vcard/ns#',
    view: NS.view,
    ws: NS.ws,
    xsd: NS.xsd
};

/**
 * The prefix table of the open workspace: compact IRIs in the editor, IRI fields, and the Turtle and TriG writers. One table for each
 * process (the backend has one model; the frontend sets it from each snapshot with `setPrefixes`).
 */
export const PREFIXES: Record<string, string> = { ...DEFAULT_PREFIXES };

/** Replace the prefix table. The object `PREFIXES` stays the same (the writers hold it). */
export function setPrefixes(prefixes: Readonly<Record<string, string>>): void {
    for (const k of Object.keys(PREFIXES)) delete PREFIXES[k];
    Object.assign(PREFIXES, prefixes);
}

/** Undefined, or why a prefix table is not valid: a name is not a Turtle prefix name, a namespace is not an absolute IRI, a namespace twice. */
export function prefixesProblem(prefixes: Readonly<Record<string, string>>): string | undefined {
    const seen = new Map<string, string>();
    for (const [prefix, ns] of Object.entries(prefixes)) {
        if (!/^[A-Za-z][\w-]*$/.test(prefix)) return `"${prefix}" is not a prefix name: a letter, then letters, digits, "_" or "-".`;
        if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]*$/.test(ns)) return `${prefix}: "${ns}" is not an absolute IRI.`;
        if (seen.has(ns)) return `${prefix}: the namespace is also the one of "${seen.get(ns)}".`;
        seen.set(ns, prefix);
    }
    return undefined;
}

/** "prefix:local" of an IRI with a known prefix; else undefined. */
export function compactParts(iri: string): { prefix: string; local: string } | undefined {
    let best: { prefix: string; local: string } | undefined;
    for (const [prefix, ns] of Object.entries(PREFIXES)) {
        if (!iri.startsWith(ns) || iri.length === ns.length) continue;
        const local = iri.slice(ns.length);
        if (!/^[A-Za-z_][\w.-]*$/.test(local)) continue;
        if (!best || ns.length > PREFIXES[best.prefix].length) best = { prefix, local };
    }
    return best;
}

/** Compact IRI: "dcat:theme", else the IRI in angle brackets. */
export function compactIri(iri: string): string {
    if (iri.startsWith('urn:name:')) return nameFromURI({ termType: 'NamedNode', value: iri } as Parameters<typeof nameFromURI>[0]) ?? `<${iri}>`;
    const c = compactParts(iri);
    return c ? `${c.prefix}:${c.local}` : `<${iri}>`;
}

/** Short text of an IRI for labels: "dcat:theme", else the local name. */
export function shortIri(iri: string): string {
    if (iri.startsWith('urn:name:')) return nameFromURI({ termType: 'NamedNode', value: iri } as Parameters<typeof nameFromURI>[0]) ?? localName(iri);
    const c = compactParts(iri);
    return c ? `${c.prefix}:${c.local}` : localName(iri);
}

/** IRI of "prefix:local", "<iri>" or an absolute IRI; undefined if the text is none of these. */
export function expandIri(text: string): string | undefined {
    const t = text.trim();
    const angle = /^<([^<>\s]+)>$/.exec(t);
    if (angle) return angle[1];
    const m = /^([A-Za-z][\w-]*):([^\s<>"{}|^`\\/]*)$/.exec(t);
    if (m && PREFIXES[m[1]] !== undefined) return PREFIXES[m[1]] + m[2];
    // "dcat:a/prov:b" is a path, not an IRI with the scheme "dcat".
    if (PREFIXES[t.split(':')[0]] !== undefined) return undefined;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]+$/.test(t) && (t.includes('/') || t.startsWith('urn:'))) return t;
    return undefined;
}

/** User-entered term (class, predicate, datatype): keep an explicit IRI; otherwise use canonical-md's reversible urn:name mapping. */
export function termIri(text: string): string | undefined {
    const name = text.trim();
    if (!name) return undefined;
    const iri = expandIri(name);
    if (iri) return iri;
    try { return nameToURI(name).value; } catch { return undefined; }
}

/**
 * A typed class (target class, class target of a property): an IRI (prefix:local, <iri>, an absolute IRI) as typed; a name: the known
 * class with that name (its label or short IRI `name`, or the local name of its IRI), when exactly one class has it; no known class: the
 * canonical-md urn:name of the name (`termIri`). `known`: the classes of the shapes and the types of the instances.
 */
export function classIri(text: string, known: Iterable<{ iri: string; name?: string }>): { iri: string } | { error: string } | undefined {
    const t = text.trim();
    if (!t) return undefined;
    const iri = expandIri(t);
    if (iri) return { iri };
    const found = new Set<string>();
    for (const c of known) if (c.name === t || localName(c.iri) === t) found.add(c.iri);
    if (found.size > 1) return { error: `More than one class is named "${t}": ${[...found].map(compactIri).sort().join(', ')}. Type prefix:local or <iri>.` };
    if (found.size === 1) return { iri: [...found][0] };
    const name = termIri(t);
    return name ? { iri: name } : undefined;
}

/** Text of an IRI in an IRI field: "prefix:local", else the IRI; "<iri>" when the bare text reads as something else. `parseIri` reads it back. */
export function iriText(iri: string): string {
    const c = compactParts(iri);
    if (c) return `${c.prefix}:${c.local}`;
    return expandIri(iri) === iri ? iri : `<${iri}>`;
}

/**
 * IRI field input: "prefix:local", "<iri>", an absolute IRI, or a name (canonical-md urn:name IRI). Empty: `iri` undefined (mint from the label).
 * "x:y" with an unknown prefix is an error, not a name.
 */
export function parseIri(text: string): { iri?: string } | { error: string } {
    const t = text.trim();
    if (!t) return {};
    const iri = expandIri(t);
    if (iri) return { iri };
    const prefix = /^([A-Za-z][\w-]*):[^/]*$/.exec(t)?.[1];
    if (prefix) return { error: `Unknown prefix "${prefix}:". Known prefixes: ${Object.keys(PREFIXES).join(', ')}. Or write the full IRI.` };
    const named = termIri(t);
    return named ? { iri: named } : { error: `"${t}" is not an IRI.` };
}

// ------------------------------------------------------------------ paths

/** Path as text in SPARQL property path syntax: "a/b", "a|b", "^a". IRIs compact. */
export function formatPath(p: PathJSON, iri: (i: string) => string = compactIri): string {
    const inner = (x: PathJSON, parent: 'sequence' | 'alternative' | 'inverse') => {
        const t = formatPath(x, iri);
        const needs = (x.kind === 'alternative' && parent !== 'alternative') || (x.kind === 'sequence' && parent === 'inverse');
        return needs ? `(${t})` : t;
    };
    switch (p.kind) {
        case 'iri': return iri(p.iri);
        case 'inverse': return '^' + inner(p.path, 'inverse');
        case 'sequence': return p.items.map(x => inner(x, 'sequence')).join('/');
        case 'alternative': return p.items.map(x => inner(x, 'alternative')).join('|');
        case 'unsupported': return p.text;
    }
}

/**
 * Parse a path in SPARQL property path syntax. Terms: prefix:local, <iri> or a name (canonical-md urn:name). A path of one term can
 * also be an absolute IRI without brackets, or a name with spaces; in a longer path an absolute IRI needs brackets ("/" is the
 * sequence operator) and a name cannot contain spaces.
 */
export function parsePath(text: string): { path: PathJSON } | { error: string } {
    // A path of one term: an IRI, or a name without path operators ("has author").
    const whole = expandIri(text) ?? (/[()|/^<>]/.test(text) ? undefined : termIri(text));
    if (whole) return { path: { kind: 'iri', iri: whole } };
    const joined = text.match(/<[^>]*>|[()|/^]|[^\s()|/^<>]+/g) ?? [];
    let i = 0;
    const peek = () => joined[i];
    const fail = (msg: string) => { throw new Error(msg); };
    const alternative = (): PathJSON => {
        const items = [sequence()];
        while (peek() === '|') { i++; items.push(sequence()); }
        return items.length === 1 ? items[0] : { kind: 'alternative', items };
    };
    const sequence = (): PathJSON => {
        const items = [unary()];
        while (peek() === '/') { i++; items.push(unary()); }
        return items.length === 1 ? items[0] : { kind: 'sequence', items };
    };
    const unary = (): PathJSON => {
        if (peek() === '^') { i++; return { kind: 'inverse', path: unary() }; }
        if (peek() === '(') {
            i++;
            const p = alternative();
            if (peek() !== ')') fail('A ")" is missing.');
            i++;
            return p;
        }
        const t = peek();
        if (t === undefined) fail('The path is empty or ends too early.');
        const iri = /^[()|/^]$/.test(t!) ? undefined : termIri(t!);
        if (!iri) fail(`"${t}" is not a name or an IRI.`);
        i++;
        return { kind: 'iri', iri: iri! };
    };
    try {
        const path = alternative();
        if (i < joined.length) fail(`Unexpected "${joined[i]}".`);
        return { path };
    } catch (e) {
        return { error: (e as Error).message };
    }
}

// ------------------------------------------------------------------ cardinality

/** "1", "0..1", "1..*", "0..*" (no min and no max), "2..5". */
export function cardinalityText(min?: number, max?: number): string {
    const lo = min ?? 0;
    if (max === undefined) return `${lo}..*`;
    return lo === max ? String(lo) : `${lo}..${max}`;
}

/** Click on the cardinality of an edge: 0..* → 0..1 → 1 → 1..* → 0..*. Other values go to 0..*. */
export function nextCardinality(min?: number, max?: number): { minCount?: number; maxCount?: number } {
    const t = cardinalityText(min, max);
    switch (t) {
        case '0..*': return { minCount: undefined, maxCount: 1 };
        case '0..1': return { minCount: 1, maxCount: 1 };
        case '1': return { minCount: 1, maxCount: undefined };
        default: return { minCount: undefined, maxCount: undefined };
    }
}

/** Parse "1", "0..1", "1..*", "2..5". */
export function parseCardinality(text: string): { minCount?: number; maxCount?: number } | undefined {
    const m = /^\s*(\d+)\s*(?:\.\.\s*(\d+|\*)\s*)?$/.exec(text);
    if (!m) return undefined;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : m[2] === '*' ? undefined : Number(m[2]);
    if (hi !== undefined && hi < lo) return undefined;
    return { minCount: lo || undefined, maxCount: hi };
}

// ------------------------------------------------------------------ ranges

const XSD = NS.xsd;
/** Datatypes offered by the editor. Others can be typed as IRIs. */
export const COMMON_DATATYPES = [
    XSD + 'string', NS.rdf + 'langString', XSD + 'dateTime', XSD + 'date', XSD + 'integer', XSD + 'decimal', XSD + 'boolean', XSD + 'anyURI',
    XSD + 'gYear', XSD + 'duration', XSD + 'nonNegativeInteger'
];

export function termText(t: TermJSON): string {
    if (t.termType === 'NamedNode') return shortIri(t.value);
    return t.language ? `"${t.value}"@${t.language}` : t.value;
}

/** Text of a range for a pill or a row: "xsd:string", "IRI", "{a, b, +3}", "scheme: Status", "Agent". */
export function rangeText(shapes: ShapesModel, r: Range, schemeLabel: (iri: string) => string = localName, max = 3): string {
    switch (r.kind) {
        case 'node': return shapes.nodeShapes[r.shape]?.label ?? 'missing shape';
        case 'class': return shortIri(r.class);
        case 'datatype': return shortIri(r.datatype);
        case 'nodeKind': return r.nodeKind;
        case 'in': {
            const shown = r.values.slice(0, r.values.length > max ? max - 1 : max).map(termText);
            return `{${shown.join(', ')}${r.values.length > shown.length ? `, +${r.values.length - shown.length}` : ''}}`;
        }
        case 'scheme': return r.schemes.map(schemeLabel).join(' | ');
        case 'collection': return schemeLabel(r.collection);
        case 'or': return r.alternatives.map(a => rangeText(shapes, a, schemeLabel, max)).join(' | ');
        case 'any': return 'any';
    }
}

/** A value set range (SKOS scheme or collection): always an edge to the node of the value set, never a row. */
export function isValueSetRange(r: Range): boolean {
    return r.kind === 'scheme' || r.kind === 'collection';
}

// ------------------------------------------------------------------ verbalization

const CARD_WORDS = (min?: number, max?: number): string => {
    const lo = min ?? 0;
    if (max === undefined) return lo === 0 ? 'zero or more' : lo === 1 ? 'one or more' : `at least ${lo}`;
    if (lo === max) return lo === 1 ? 'exactly one' : `exactly ${lo}`;
    if (lo === 0) return max === 1 ? 'at most one' : `at most ${max}`;
    return `between ${lo} and ${max}`;
};

function rangeWords(shapes: ShapesModel, p: PropertyShape, schemeLabel: (iri: string) => string): string {
    return rangeWordsOf(shapes, p.range, schemeLabel);
}

function rangeWordsOf(shapes: ShapesModel, r: Range, schemeLabel: (iri: string) => string): string {
    switch (r.kind) {
        case 'node': return `, each a ${shapes.nodeShapes[r.shape]?.label ?? 'missing shape'}`;
        case 'class': return `, each an instance of ${shortIri(r.class)}`;
        case 'datatype': return `, each a ${shortIri(r.datatype)}`;
        case 'nodeKind': return `, each ${r.nodeKind === 'IRI' ? 'an IRI' : r.nodeKind === 'Literal' ? 'a literal' : `a ${r.nodeKind}`}`;
        case 'in': return `, each one of ${rangeText(shapes, r, schemeLabel, 12)}`;
        case 'scheme': return `, each a concept in the ${r.schemes.map(schemeLabel).join(' or ')} scheme${r.schemes.length > 1 ? 's' : ''}`;
        case 'collection': return `, each a member of the ${schemeLabel(r.collection)} collection`;
        case 'or': return ', each' + r.alternatives.map(a => rangeWordsOf(shapes, a, schemeLabel).replace(/^, each/, '')).join(' or');
        case 'any': return '';
    }
}

/** "Each Data asset has exactly one dct:title, each a xsd:string." */
export function verbalizeProperty(shapes: ShapesModel, p: PropertyShape, schemeLabel: (iri: string) => string = localName): string {
    const owner = shapes.nodeShapes[p.owner]?.label ?? 'focus node';
    const extra = [
        p.pattern ? `matching /${p.pattern}/` : '', p.minLength !== undefined ? `at least ${p.minLength} characters` : '',
        p.maxLength !== undefined ? `at most ${p.maxLength} characters` : '', p.languageIn?.length ? `in language ${p.languageIn.join(', ')}` : ''
    ].filter(Boolean);
    return `Each ${owner} has ${CARD_WORDS(p.minCount, p.maxCount)} ${formatPath(p.path)}${rangeWords(shapes, p, schemeLabel)}${extra.length ? ` (${extra.join(', ')})` : ''}.`;
}

/**
 * Why concept `broader` cannot be a broader concept of `uri`; undefined: it can. Both concepts belong to a value set (`isMember`), and
 * no concept becomes broader than itself, directly or through other concepts (`parentsOf`: the broader concepts of one concept).
 * Used by the canvas (conceptParents) and the store (shape-ops.setConceptBroader).
 */
export function broaderProblem(uri: string, broader: string, isMember: (uri: string) => boolean, parentsOf: (uri: string) => Iterable<string>): string | undefined {
    if (!isMember(uri) || !isMember(broader)) return 'Both concepts must belong to a concept scheme or collection.';
    const pending = [broader], seen = new Set<string>();
    while (pending.length) {
        const parent = pending.pop()!;
        if (parent === uri) return 'A concept cannot be broader than itself, directly or through other concepts.';
        if (seen.has(parent)) continue;
        seen.add(parent);
        pending.push(...parentsOf(parent));
    }
    return undefined;
}

/** Broader concepts by concept: of the value set members and of `concepts` (skos:broader and inverse skos:narrower of all files). */
export function conceptParents(shapes: ShapesModel, concepts: { iri: string; broader: string[] }[] = []): (uri: string) => string[] {
    const parents = new Map<string, string[]>();
    const add = (uri: string, broader: string[] = []) => parents.set(uri, [...parents.get(uri) ?? [], ...broader]);
    for (const v of Object.values(shapes.valueSets)) for (const m of v.members) add(m.uri, m.broader);
    for (const c of concepts) add(c.iri, c.broader);
    return uri => parents.get(uri) ?? [];
}

/** True: `uri` is a concept of a concept scheme or collection. */
export function isValueSetMember(shapes: ShapesModel, uri: string): boolean {
    return Object.values(shapes.valueSets).some(v => v.members.some(m => m.uri === uri));
}

/**
 * Why the card `id` cannot be the target of a property; undefined: it can. A target is a node shape, a concept scheme or a collection
 * (rangeOfShape), not one of `taken` (the current targets). The own node shape is a target: a property can point to its shape.
 */
export function propertyTargetProblem(shapes: ShapesModel, id: string, taken: Range[] = []): string | undefined {
    const range = rangeOfShape(shapes, id);
    if (!range) return 'A property points to a node shape, a concept scheme or a collection.';
    const key = rangeKey(range);
    return taken.some(t => alternativesOf(t).some(a => rangeKey(a) === key)) ? 'The property points to it already.' : undefined;
}

/** "Each Data asset has either a dct:description or a dcat:theme (or)." */
export function verbalizeConstraint(shapes: ShapesModel, c: LogicalConstraint): string {
    const owner = shapes.nodeShapes[c.owner]?.label ?? 'focus node';
    const parts = c.members.map(id => shapes.properties[id]).filter(p => !!p).map(p => {
        const range = p.range.kind === 'any' ? '' : ` (${rangeText(shapes, p.range)})`;
        return `${CARD_WORDS(p.minCount, p.maxCount)} ${formatPath(p.path)}${range}`;
    });
    const list = (word: string) => parts.length <= 2 ? parts.join(` ${word} `) : `${parts.slice(0, -1).join(', ')} ${word} ${parts[parts.length - 1]}`;
    switch (c.operator) {
        case 'or': return `Each ${owner} has ${parts.length > 1 ? 'either ' : ''}${list('or')}${c.raw.length ? ', or matches another shape' : ''} (or).`;
        case 'xone': return `Each ${owner} has exactly one of: ${list('or')} (xone).`;
        case 'and': return `Each ${owner} has ${list('and')} (and).`;
        case 'not': return `No ${owner} has ${list('or')} (not).`;
    }
}

/** Node shape and its properties, one sentence each. */
export function verbalizeShape(shapes: ShapesModel, s: NodeShape, schemeLabel: (iri: string) => string = localName): string[] {
    const lines: string[] = [];
    if (s.targetClass) lines.push(`A ${s.label} is an instance of ${shortIri(s.targetClass)}.`);
    if (s.targetSubjectsOf?.length) lines.push(`A ${s.label} checks subjects of ${s.targetSubjectsOf.map(shortIri).join(' or ')}.`);
    if (!lines.length) lines.push(`${s.label} has no target class: it checks only the nodes that other shapes send to it (sh:node).`);
    if (s.closed) lines.push(`A ${s.label} has no properties other than these (closed).`);
    for (const id of s.properties) {
        const p = shapes.properties[id];
        if (p && !p.constraint) lines.push(verbalizeProperty(shapes, p, schemeLabel));
    }
    for (const id of s.constraints) {
        const c = shapes.constraints[id];
        if (c) lines.push(verbalizeConstraint(shapes, c));
    }
    return lines;
}

/** Color of a namespace for edge labels: a stable pick from a small palette. */
export function namespaceColor(iri: string): string {
    const c = compactParts(iri);
    const ns = c ? PREFIXES[c.prefix] : iri.replace(/[^#/]*$/, '');
    let h = 0;
    for (let i = 0; i < ns.length; i++) h = (h * 31 + ns.charCodeAt(i)) >>> 0;
    return NS_COLORS[h % NS_COLORS.length];
}
const NS_COLORS = ['#5ad3c4', '#e070c8', '#e0a050', '#7aa7ff', '#9bd46a', '#f07a7a'];

/** Label parts of a path: prefixes and operators muted, local names in the color of their namespace. */
export function pathParts(p: PathJSON): { text: string; color?: string }[] {
    const parts: { text: string; color?: string }[] = [];
    for (const token of formatPath(p).split(/([()|/^])/).filter(Boolean)) {
        const iri = expandIri(token);
        const c = iri ? compactParts(iri) : undefined;
        if (c) parts.push({ text: c.prefix + ':' }, { text: c.local, color: namespaceColor(iri!) });
        else parts.push({ text: token, color: iri ? namespaceColor(iri) : undefined });
    }
    return parts;
}
