// The SHACL providers of the palette, links and fields contracts. A node shape gives a palette class for each sh:targetClass (and for
// itself when it is also a class). Its property shapes (sh:property, and the members of sh:or, sh:xone and sh:and) give a link for
// sh:class or sh:node, else a field (sh:datatype, sh:in, sh:nodeKind sh:IRI). The host gives a port on the shapes graphs only.

import type { FieldRule, FieldValue, FieldsProvider } from '@catenary/fields';
import type { LinkRule, LinksProvider } from '@catenary/links';
import type { PaletteClass, PaletteProvider } from '@catenary/palette';
import { OWL, QueryPort, RDF, RDFS, SH, XSD } from '@catenary/query';

const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const DCT = 'http://purl.org/dc/terms/';

interface Node { termType: string; value: string; language?: string; datatype?: { value: string } }

/** The triples of the shapes graphs, by subject and predicate. */
class Triples {
    protected readonly bySubject = new Map<string, Map<string, Node[]>>();
    readonly all: { s: Node; p: string; o: Node }[] = [];

    constructor(port: QueryPort) {
        const seen = new Set<string>();
        for (const r of port.select(`SELECT ?s ?p ?o WHERE { ${port.graph('?s ?p ?o')} }`) as Record<string, Node>[]) {
            const k = [key(r.s), r.p.value, key(r.o), r.o.language ?? '', r.o.datatype?.value ?? ''].join('\u0000');
            if (seen.has(k)) continue;
            seen.add(k);
            this.all.push({ s: r.s, p: r.p.value, o: r.o });
            const ps = this.bySubject.get(key(r.s)) ?? new Map<string, Node[]>();
            this.bySubject.set(key(r.s), ps);
            ps.set(r.p.value, [...(ps.get(r.p.value) ?? []), r.o]);
        }
    }

    /** The objects of `s` and `p`, in value order. */
    objects(s: Node, p: string): Node[] {
        return (this.bySubject.get(key(s))?.get(p) ?? []).slice().sort((a, b) => a.value.localeCompare(b.value));
    }

    /** The first object in value order: a stable choice when there are several. */
    first(s: Node, p: string): Node | undefined { return this.objects(s, p)[0]; }
    str(s: Node, p: string): string | undefined { return this.first(s, p)?.value; }
    int(s: Node, p: string): number | undefined { const v = this.str(s, p); return v === undefined ? undefined : Number(v); }

    /** A plain or English literal first, then the others in value order; the first predicate that has one. */
    text(s: Node, ...preds: string[]): string | undefined {
        for (const p of preds) {
            const terms = this.objects(s, p).filter(t => t.termType === 'Literal');
            const hit = terms.find(t => !t.language || t.language.startsWith('en')) ?? terms[0];
            if (hit) return hit.value;
        }
        return undefined;
    }

    /** The members of the RDF list at `head`; undefined when it is not a well-formed list. */
    list(head: Node): Node[] | undefined {
        const out: Node[] = [], visited = new Set<string>();
        for (let cell = head; !(cell.termType === 'NamedNode' && cell.value === RDF + 'nil');) {
            if (visited.has(key(cell))) return undefined;
            visited.add(key(cell));
            const first = this.objects(cell, RDF + 'first'), rest = this.objects(cell, RDF + 'rest');
            if (first.length !== 1 || rest.length !== 1) return undefined;
            out.push(first[0]);
            cell = rest[0];
        }
        return out;
    }

    /** The list that is the only object of `s` and `p`. */
    listOf(s: Node, p: string): Node[] | undefined {
        const heads = this.objects(s, p);
        return heads.length === 1 ? this.list(heads[0]) : undefined;
    }

    /** The subjects of `p` (and object `o`), each once. */
    subjects(p: string, o?: string): Node[] {
        const out = new Map<string, Node>();
        for (const t of this.all) if (t.p === p && (o === undefined || t.o.value === o && t.o.termType === 'NamedNode')) out.set(key(t.s), t.s);
        return [...out.values()];
    }
}

const key = (t: Node) => (t.termType === 'NamedNode' ? '<' + t.value + '>' : t.termType === 'BlankNode' ? '_:' + t.value : '"' + t.value);
const named = (value: string): Node => ({ termType: 'NamedNode', value });
const same = (a: Node, b: Node) => key(a) === key(b);

/** An sh:in member as JSON; a blank node gives none. */
function valueOf(t: Node): FieldValue | undefined {
    if (t.termType === 'NamedNode') return { termType: 'NamedNode', value: t.value };
    if (t.termType !== 'Literal') return undefined;
    const v: FieldValue = { termType: 'Literal', value: t.value };
    if (t.language) v.language = t.language;
    else if (t.datatype && t.datatype.value !== XSD + 'string') v.datatype = t.datatype.value;
    return v;
}

/** The kind of a complex path, from its structure (not its term type); undefined: a predicate path. */
function describePath(t: Triples, path: Node): string | undefined {
    const has = (p: string) => t.objects(path, p).length > 0;
    if (has(SH + 'inversePath')) return 'inverse';
    if (has(SH + 'alternativePath')) return 'alternative';
    if (has(SH + 'zeroOrMorePath') || has(SH + 'oneOrMorePath') || has(SH + 'zeroOrOnePath')) return 'repeated';
    if (has(RDF + 'first')) return 'sequence';
    return path.termType === 'NamedNode' ? undefined : 'complex';
}

/**
 * The value set of a helper shape (see shape-ops.ts in @catenary/rdf), else undefined: a member shape (`dct:source` C, `sh:in` on the
 * node shape): C and the list; a scheme shape (one property `skos:inScheme` `sh:hasValue` S): S (the host gives its concepts).
 */
function valueSetOf(t: Triples, shape: Node): LinkRule['valueSet'] {
    const members = t.listOf(shape, SH + 'in');
    if (members) return { iri: t.str(shape, DCT + 'source') ?? shape.value, values: members.filter(m => m.termType === 'NamedNode').map(m => m.value) };
    const props = t.objects(shape, SH + 'property');
    if (props.length !== 1 || t.str(props[0], SH + 'path') !== SKOS + 'inScheme') return undefined;
    const scheme = t.first(props[0], SH + 'hasValue');
    return scheme ? { iri: scheme.value } : undefined;
}

interface Authoring { classes: PaletteClass[]; links: LinkRule[]; fields: FieldRule[] }

const read = new WeakMap<QueryPort, Authoring>();

/** The palette classes, links and fields of the shapes, read once for each port. */
function authoring(port: QueryPort): Authoring {
    const cached = read.get(port);
    if (cached) return cached;
    const t = new Triples(port);

    // Node shapes and their target classes. A shape that is also a class targets itself.
    const targets: { shape: Node; cls: string }[] = [];
    for (const shape of t.subjects(SH + 'targetClass')) for (const c of t.objects(shape, SH + 'targetClass')) targets.push({ shape, cls: c.value });
    for (const shape of t.subjects(RDF + 'type', SH + 'NodeShape')) {
        const isClass = t.objects(shape, RDF + 'type').some(c => c.value === RDFS + 'Class' || c.value === OWL + 'Class');
        if (isClass && shape.termType === 'NamedNode') targets.push({ shape, cls: shape.value });
    }
    // Stable order: the description and the order of a class come from its first shape.
    targets.sort((a, b) => a.shape.value.localeCompare(b.shape.value));
    const classOfShape = (shape: Node) => targets.find(x => same(x.shape, shape))?.cls;

    const byClass = new Map<string, PaletteClass & { sources: string[]; notes: string[] }>();
    const links: LinkRule[] = [], fields: FieldRule[] = [];
    for (const { shape, cls } of targets) {
        let def = byClass.get(cls);
        if (!def) byClass.set(cls, def = { iri: cls, sources: [], notes: [] });
        def.sources.push(shape.value);
        def.description ??= t.str(shape, SH + 'description') ?? t.str(shape, RDFS + 'comment');
        def.order ??= t.int(shape, SH + 'order');

        // sh:property, and the members of the logical constraints sh:or, sh:xone, sh:and (one of them, or all, applies).
        const members = ['or', 'xone', 'and'].flatMap(op => t.objects(shape, SH + op).flatMap(head =>
            (t.list(head) ?? []).map(p => ({ ps: p, optional: op !== 'and' }))));
        for (const { ps, optional } of [...t.objects(shape, SH + 'property').map(ps => ({ ps, optional: false })), ...members]) {
            const path = t.first(ps, SH + 'path');
            const name = t.str(ps, SH + 'name');
            if (!path) continue;
            const kind = describePath(t, path);
            if (kind) {
                def.notes.push(`${name ?? 'property'}: ${kind} path is not supported`);
                continue;
            }
            // rdf:type is built in.
            if (path.value === RDF + 'type') continue;

            const common = {
                domain: cls, predicate: path.value, name, description: t.str(ps, SH + 'description'),
                minCount: optional ? undefined : t.int(ps, SH + 'minCount'), maxCount: t.int(ps, SH + 'maxCount'), order: t.int(ps, SH + 'order')
            };
            // A field of rdfs:label: the form edits the label.
            if (path.value === RDFS + 'label') {
                fields.push({ ...common, iri: false });
                continue;
            }
            // A property with sh:or of ranges (no sh:path in the members): each member is an alternative range.
            const orItems = t.objects(ps, SH + 'or').flatMap(head => t.list(head) ?? []);
            const alternatives = orItems.length && orItems.every(x => !t.objects(x, SH + 'path').length) ? orItems : [ps];
            const literal: { datatype?: string; iri: boolean; in?: FieldValue[] }[] = [];
            for (const alt of alternatives) {
                const shClass = t.first(alt, SH + 'class');
                const shNode = t.first(alt, SH + 'node');
                const valueSet = shNode && valueSetOf(t, shNode);
                if (valueSet) {
                    // A concept of a scheme or a member of a collection: a link to skos:Concept, to these concepts only.
                    links.push({ ...common, target: SKOS + 'Concept', valueSet });
                } else if (shClass) {
                    links.push({ ...common, target: shClass.value });
                } else if (shNode) {
                    const target = classOfShape(shNode);
                    if (target) links.push({ ...common, target });
                    else def.notes.push(`${name ?? localName(path.value)}: sh:node ${shNode.value} has no target class`);
                } else {
                    const values = t.listOf(alt, SH + 'in')?.map(valueOf).filter((v): v is FieldValue => v !== undefined);
                    literal.push({
                        datatype: t.str(alt, SH + 'datatype'),
                        iri: t.str(alt, SH + 'nodeKind') === SH + 'IRI' || (values?.length ? values.every(v => v.termType === 'NamedNode') : false),
                        in: values
                    });
                }
            }
            // Literal alternatives: one field (a datatype only when all alternatives have the same one).
            if (literal.length) {
                const datatypes = new Set(literal.map(f => f.datatype));
                fields.push({ ...common, datatype: datatypes.size === 1 ? literal[0].datatype : undefined, iri: literal.every(f => f.iri), in: literal.length === 1 ? literal[0].in : undefined });
            }
        }
    }
    const classes = [...byClass.values()].map(c => {
        const name = t.text(named(c.iri), RDFS + 'label', SKOS + 'prefLabel');
        return name === undefined ? c : { ...c, name };
    });
    const out = { classes, links, fields };
    read.set(port, out);
    return out;
}

/** The local name of an IRI (as localName in @catenary/model). */
function localName(iri: string): string {
    const m = /[#/:]([^#/:]+)[#/]?$/.exec(iri);
    return m ? decodeURIComponent(m[1]) : iri;
}

export const shaclPalette: PaletteProvider = { id: 'shacl', classes: port => authoring(port).classes };
export const shaclLinks: LinksProvider = { id: 'shacl', links: port => authoring(port).links };
export const shaclFields: FieldsProvider = { id: 'shacl', fields: port => authoring(port).fields };
