// SHACL shapes -> metamodel (palette classes, relation types, fields, SKOS concepts; types in @catenary/model).
// The tool reads shapes only. See the mapping table in readme.md.

import { ClassDef, Classes, ConceptDef, NS, SchemeDef, TermJSON, localName, shortIri, termToJSON } from '@catenary/model';
import type { Quad, Term } from '@rdfjs/types';
import type { Dataset, Grapoi } from 'rdf-ext';
import { rdf } from './terms';

export interface Metamodel extends Classes {
    source?: string;             // file name or IRI of the shapes file
    dataset: Dataset;            // shapes, for shacl-engine
}

const COLORS = ['6', '4', '5', '2', '3', '1'];

export function emptyMetamodel(): Metamodel {
    return { classes: [], dataset: rdf.dataset() };
}

/** Metamodel of the shapes in `quads`, in any graph (the union of several shapes files). */
export function metamodelFromQuads(quads: Iterable<Quad>, source?: string): Metamodel {
    const dataset = rdf.dataset([...quads].map(q => rdf.quad(q.subject, q.predicate, q.object)));
    return { ...buildMetamodel(dataset), source, dataset };
}

const n = (iri: string) => rdf.namedNode(iri);
/** First object value in term order: a stable choice when there are several. */
const first = (ptr: Grapoi) => ptr.terms.sort((a, b) => a.value.localeCompare(b.value))[0];
const str = (ptr: Grapoi) => first(ptr)?.value;
/** A plain or English literal first, then the others in term order; the first predicate that has one. */
const text = (ptr: Grapoi, ...preds: string[]) => {
    for (const p of preds) {
        const terms = ptr.out(n(p)).terms.filter(t => t.termType === 'Literal').sort((a, b) => a.value.localeCompare(b.value));
        const hit = terms.find(t => !(t as { language?: string }).language || (t as { language: string }).language.startsWith('en')) ?? terms[0];
        if (hit) return hit.value;
    }
    return undefined;
};
const int = (ptr: Grapoi) => { const v = str(ptr); return v === undefined ? undefined : Number(v); };

const SH = NS.sh;

export function buildMetamodel(quads: Iterable<Quad>): Classes {
    const dataset = rdf.dataset([...quads]);
    const node = (t: Term) => rdf.grapoi({ dataset, term: t });
    const vocabulary = buildVocabulary(dataset);
    const subjects = (p: string, o?: string) => [...rdf.termSet([...dataset.match(null, n(p), o ? n(o) : null)].map(q => q.subject))];

    // Node shapes and their target classes. A shape that is also a class targets itself.
    const targets: { shape: Term; cls: string }[] = [];
    for (const shape of subjects(SH + 'targetClass')) {
        for (const c of node(shape).out(n(SH + 'targetClass')).terms) targets.push({ shape, cls: c.value });
    }
    for (const shape of subjects(NS.rdf + 'type', SH + 'NodeShape')) {
        const isClass = node(shape).out(n(NS.rdf + 'type')).values.some(t => t === NS.rdfs + 'Class' || t === NS.owl + 'Class');
        if (isClass && shape.termType === 'NamedNode') targets.push({ shape, cls: shape.value });
    }
    // Stable order: description and order of a class come from its first shape.
    targets.sort((a, b) => a.shape.value.localeCompare(b.shape.value));

    const classOfShape = (shape: Term) => targets.find(t => t.shape.equals(shape))?.cls;

    const byClass = new Map<string, ClassDef>();
    for (const { shape, cls } of targets) {
        let def = byClass.get(cls);
        if (!def) {
            def = { iri: cls, name: '', shapes: [], fields: [], relations: [], unsupported: [], color: '', labelInShape: false };
            byClass.set(cls, def);
        }
        const sh = node(shape);
        def.shapes.push(shape.value);
        def.description ??= str(sh.out(n(SH + 'description'))) ?? str(sh.out(n(NS.rdfs + 'comment')));
        def.order ??= int(sh.out(n(SH + 'order')));

        // Properties: sh:property, and the members of the logical constraints sh:or, sh:xone, sh:and (one of them, or all, applies).
        const members = ['or', 'xone', 'and'].flatMap(op => sh.out(n(SH + op)).terms.flatMap(head => {
            const list = node(head);
            return list.isList() ? [...list.list()!].map(p => ({ term: p.term!, optional: op !== 'and' })) : [];
        }));
        for (const { term: psTerm, optional } of [...sh.out(n(SH + 'property')).terms.map(term => ({ term, optional: false })), ...members]) {
            const ps = node(psTerm);
            const path = first(ps.out(n(SH + 'path')));
            const name = str(ps.out(n(SH + 'name')));
            if (!path) continue;
            const kind = describePath(node(path));
            if (kind) {
                def.unsupported.push(`${name ?? 'property'}: ${kind} path is not supported`);
                continue;
            }
            // rdfs:label and rdf:type are built in.
            if (path.value === NS.rdfs + 'label') def.labelInShape = true;
            if (path.value === NS.rdfs + 'label' || path.value === NS.rdf + 'type') continue;

            const common = {
                path: path.value,
                name: name ?? localName(path.value),
                description: str(ps.out(n(SH + 'description'))),
                minCount: optional ? undefined : int(ps.out(n(SH + 'minCount'))),
                maxCount: int(ps.out(n(SH + 'maxCount'))),
                order: int(ps.out(n(SH + 'order')))
            };
            // A property with sh:or of ranges (no sh:path in the members): each member is an alternative range.
            const orItems = ps.out(n(SH + 'or')).terms.flatMap(head => { const l = node(head); return l.isList() ? [...l.list()!].map(x => x.term!) : []; });
            const alternatives = orItems.length && orItems.every(t => !node(t).out(n(SH + 'path')).terms.length) ? orItems.map(node) : [ps];
            const fields: { datatype?: string; iri: boolean; in?: TermJSON[] }[] = [];
            for (const alt of alternatives) {
                const shClass = first(alt.out(n(SH + 'class')));
                const shNode = first(alt.out(n(SH + 'node')));
                const valueSet = shNode && valueSetOf(dataset, vocabulary.concepts, shNode);
                if (valueSet) {
                    // A concept of a scheme or a member of a collection: a relation to skos:Concept, to these concepts only.
                    def.relations.push({ ...common, targetClass: SKOS + 'Concept', valueSet: valueSet.iri, values: valueSet.values });
                } else if (shClass) {
                    def.relations.push({ ...common, targetClass: shClass.value });
                } else if (shNode) {
                    const target = classOfShape(shNode);
                    if (target) def.relations.push({ ...common, targetClass: target });
                    else def.unsupported.push(`${common.name}: sh:node ${shNode.value} has no target class`);
                } else {
                    const inList = alt.out(n(SH + 'in'));
                    const items = inList.isList() ? [...inList.list()!].map(p => p.term!) : undefined;
                    const values = items?.map(termToJSON).filter((t): t is TermJSON => t !== undefined);
                    fields.push({
                        datatype: str(alt.out(n(SH + 'datatype'))),
                        iri: str(alt.out(n(SH + 'nodeKind'))) === SH + 'IRI' || (values?.length ? values.every(v => v.termType === 'NamedNode') : false),
                        in: values
                    });
                }
            }
            // Literal alternatives: one field (a datatype only when all alternatives have the same one).
            if (fields.length) {
                const datatypes = new Set(fields.map(f => f.datatype));
                def.fields.push({ ...common, datatype: datatypes.size === 1 ? fields[0].datatype : undefined, iri: fields.every(f => f.iri), in: fields.length === 1 ? fields[0].in : undefined });
            }
        }
    }

    const classes = [...byClass.values()];
    for (const c of classes) {
        // The name of the class, not of its shapes: a shape name (sh:name) is shown on the shape.
        c.name = text(node(n(c.iri)), NS.rdfs + 'label', NS.skos + 'prefLabel') ?? shortIri(c.iri);
        c.fields.sort(byOrderThenName);
        c.relations.sort(byOrderThenName);
    }
    classes.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name));
    classes.forEach((c, i) => { c.color = COLORS[i % COLORS.length]; });
    return { classes, ...vocabulary };
}

/**
 * The value set of a helper shape (see shape-ops.ts) and its allowed values, else undefined: a scheme shape (one property
 * `skos:inScheme` `sh:hasValue` S): S and its concepts; a member shape (`dct:source` C, `sh:in` on the node shape): C and the list.
 */
function valueSetOf(dataset: Dataset, concepts: ConceptDef[], shape: Term): { iri: string; values: string[] } | undefined {
    const ptr = rdf.grapoi({ dataset, term: shape });
    const inList = ptr.out(n(SH + 'in'));
    if (inList.isList()) {
        const values = [...inList.list()!].map(p => p.term!).filter(t => t.termType === 'NamedNode').map(t => t.value);
        return { iri: str(ptr.out(n(NS.dct + 'source'))) ?? shape.value, values };
    }
    const props = ptr.out(n(SH + 'property'));
    if (props.terms.length !== 1) return undefined;
    if (first(props.out(n(SH + 'path')))?.value !== SKOS + 'inScheme') return undefined;
    const scheme = first(props.out(n(SH + 'hasValue')));
    return scheme ? { iri: scheme.value, values: concepts.filter(c => c.schemes.includes(scheme.value)).map(c => c.iri) } : undefined;
}

/**
 * The shapes as the instance form reads them: a property with a value set helper (`sh:node`) gets `sh:in` of the allowed values
 * instead of `sh:node` and `sh:class`, so that the form offers the concepts. Validation uses the shapes as they are.
 */
export function formShapes(meta: Metamodel): Dataset {
    const { dataset } = meta;
    const concepts = meta.concepts ?? [];
    const out = rdf.dataset([...dataset]);
    for (const q of [...dataset.match(null, n(SH + 'node'), null)]) {
        const values = valueSetOf(dataset, concepts, q.object)?.values;
        if (!values) continue;
        for (const p of [SH + 'node', SH + 'class']) for (const r of [...out.match(q.subject, n(p), null)]) out.delete(r);
        let list: Term = n(NS.rdf + 'nil');
        values.slice().reverse().forEach((v, i) => {
            const cell = n(`${q.subject.value}-in-${values.length - i}`);
            out.add(rdf.quad(cell, n(NS.rdf + 'first'), n(v)));
            out.add(rdf.quad(cell, n(NS.rdf + 'rest'), list as never));
            list = cell;
        });
        out.add(rdf.quad(q.subject, n(SH + 'in'), list as never));
    }
    return out;
}

const SKOS = NS.skos;

/** SKOS concept schemes and concepts in the shapes files. */
function buildVocabulary(dataset: Dataset): { schemes: SchemeDef[]; concepts: ConceptDef[] } {
    const node = (t: Term) => rdf.grapoi({ dataset, term: t });
    const iris = (p: string, o?: string, side: 'subject' | 'object' = 'subject') =>
        [...dataset.match(null, n(p), o ? n(o) : null)].map(q => q[side]).filter(t => t.termType === 'NamedNode').map(t => t.value);
    // A plain or English label first, then the others in term order.
    const text = (iri: string, ...preds: string[]) => {
        for (const p of preds) {
            const terms = node(n(iri)).out(n(p)).terms.sort((a, b) => a.value.localeCompare(b.value));
            const hit = terms.find(t => t.termType === 'Literal' && (!t.language || t.language.startsWith('en'))) ?? terms[0];
            if (hit) return hit.value;
        }
        return undefined;
    };

    const schemeIris = new Set([
        ...iris(NS.rdf + 'type', SKOS + 'ConceptScheme'), ...iris(SKOS + 'hasTopConcept'),
        ...iris(SKOS + 'inScheme', undefined, 'object'), ...iris(SKOS + 'topConceptOf', undefined, 'object')
    ]);
    const conceptIris = new Set([
        ...iris(NS.rdf + 'type', SKOS + 'Concept'), ...iris(SKOS + 'inScheme'), ...iris(SKOS + 'topConceptOf'),
        ...iris(SKOS + 'hasTopConcept', undefined, 'object'), ...iris(SKOS + 'broader'), ...iris(SKOS + 'narrower'),
        ...iris(SKOS + 'broader', undefined, 'object'), ...iris(SKOS + 'narrower', undefined, 'object')
    ]);
    for (const s of schemeIris) conceptIris.delete(s);

    const pairs = (p: string) => [...dataset.match(null, n(p), null)].filter(q => q.subject.termType === 'NamedNode' && q.object.termType === 'NamedNode');
    const concepts = new Map<string, ConceptDef>([...conceptIris].map(iri => [iri, {
        iri, label: text(iri, SKOS + 'prefLabel', NS.rdfs + 'label') ?? localName(iri),
        notation: text(iri, SKOS + 'notation'),
        definition: text(iri, SKOS + 'definition', NS.rdfs + 'comment'),
        schemes: [], broader: [], top: false
    }]));
    const add = (list: string[], v: string) => { if (!list.includes(v)) list.push(v); };
    for (const q of pairs(SKOS + 'inScheme')) { const c = concepts.get(q.subject.value); if (c) add(c.schemes, q.object.value); }
    for (const q of pairs(SKOS + 'topConceptOf')) { const c = concepts.get(q.subject.value); if (c) { add(c.schemes, q.object.value); c.top = true; } }
    for (const q of pairs(SKOS + 'hasTopConcept')) { const c = concepts.get(q.object.value); if (c) { add(c.schemes, q.subject.value); c.top = true; } }
    for (const q of pairs(SKOS + 'broader')) { const c = concepts.get(q.subject.value); if (c && concepts.has(q.object.value)) add(c.broader, q.object.value); }
    for (const q of pairs(SKOS + 'narrower')) { const c = concepts.get(q.object.value); if (c && concepts.has(q.subject.value)) add(c.broader, q.subject.value); }

    const schemes = [...schemeIris].map(iri => ({
        iri, label: text(iri, SKOS + 'prefLabel', NS.dct + 'title', NS.rdfs + 'label') ?? localName(iri),
        description: text(iri, NS.dct + 'description', SKOS + 'definition', NS.rdfs + 'comment')
    }));
    const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
    return { schemes: schemes.sort(byLabel), concepts: [...concepts.values()].sort(byLabel) };
}

function byOrderThenName(a: { order?: number; name: string }, b: { order?: number; name: string }): number {
    return (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name);
}

/** The kind of a complex path, from its structure (not its term type); undefined: a predicate path. */
function describePath(path: Grapoi): string | undefined {
    const has = (p: string) => path.out(n(p)).terms.length > 0;
    if (has(SH + 'inversePath')) return 'inverse';
    if (has(SH + 'alternativePath')) return 'alternative';
    if (has(SH + 'zeroOrMorePath') || has(SH + 'oneOrMorePath') || has(SH + 'zeroOrOnePath')) return 'repeated';
    if (has(NS.rdf + 'first')) return 'sequence';
    return path.term?.termType === 'NamedNode' ? undefined : 'complex';
}
