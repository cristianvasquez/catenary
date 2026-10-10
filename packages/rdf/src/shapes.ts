// The shapes dataset of the metamodel (the instance form, the panels) and the SKOS vocabulary of the value sets. The validator reads the
// shapes graphs, not this copy (spec/manifest.hs §9). The palette classes, links and fields come from the plugins (authoring.ts): this
// file reads no SHACL property shape for them.

import { ANY_RESOURCE, ClassDef, Classes, ConceptDef, NS, SchemeDef, localName, pluginFormShape, pluginParts } from '@catenary/model';
import type { Quad, Term } from '@rdfjs/types';
import type { Dataset, Grapoi } from 'rdf-ext';
import { OxigraphStore } from 'rdf-files';
import { AUTHORING_PLUGINS, authoringMetamodel } from './authoring';
import { ModelGraph } from './graph';
import { rdf } from './terms';

export interface Metamodel extends Classes {
    source?: string;             // file name or IRI of the shapes file
    dataset: Dataset;            // shapes and vocabulary, for the form
}

export function emptyMetamodel(): Metamodel {
    return { classes: [], dataset: rdf.dataset() };
}

/** Metamodel of the shapes in `quads`, in any graph (the union of several shapes files): the SHACL plugin only. */
export function metamodelFromQuads(quads: Iterable<Quad>, source?: string): Metamodel {
    const triples = [...quads].map(q => rdf.quad(q.subject, q.predicate, q.object));
    const dataset = rdf.dataset(triples);
    const g = new ModelGraph(new OxigraphStore(triples.map(q => rdf.quad(q.subject, q.predicate, q.object, n(SHAPES_GRAPH)))));
    const shacl = AUTHORING_PLUGINS.filter(p => p.reads === 'shapes');
    return { ...authoringMetamodel(g, buildVocabulary(dataset), shacl, [SHAPES_GRAPH]), source, dataset };
}

/** The graph of the shapes in metamodelFromQuads. */
const SHAPES_GRAPH = 'urn:catenary:shapes';

const n = (iri: string) => rdf.namedNode(iri);
/** First object value in term order: a stable choice when there are several. */
const first = (ptr: Grapoi) => ptr.terms.sort((a, b) => a.value.localeCompare(b.value))[0];
const str = (ptr: Grapoi) => first(ptr)?.value;

const SH = NS.sh;

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
 * instead of `sh:node` and `sh:class`, so that the form offers the concepts. The fields and links of the other plugins get form node shapes. Validation uses
 * the shapes as they are.
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
    // The fields and links of the plugins other than the shapes (RDFS): one form node shape for each class and plugin (pluginFormShape), with one property for
    // each predicate. Several ranges of a predicate are alternatives (sh:or). A relation to any resource has its field. Not saved, not validated.
    const range = (node: Term, x: ClassDef['fields'][number] | ClassDef['relations'][number]) => {
        if ('targetClass' in x) {
            out.add(rdf.quad(node as never, n(SH + 'class'), n(x.targetClass)));
            out.add(rdf.quad(node as never, n(SH + 'nodeKind'), n(SH + 'IRI')));
        } else if (x.datatype) out.add(rdf.quad(node as never, n(SH + 'datatype'), n(x.datatype)));
    };
    for (const cls of meta.classes) for (const [source, parts] of pluginParts(cls)) {
        const shape = n(pluginFormShape(source, cls.iri));
        out.add(rdf.quad(shape, n(NS.rdf + 'type'), n(SH + 'NodeShape')));
        const paths = [...new Set(parts.map(x => x.path))];
        paths.forEach((path, i) => {
            // A class range admits its subclasses too: each is an alternative.
            const ranges = parts.filter(x => x.path === path && !('targetClass' in x && x.targetClass === ANY_RESOURCE))
                .flatMap((x): typeof parts => 'targetClass' in x ? [x, ...(x.targetSubclasses ?? []).map(c => ({ ...x, targetClass: c }))] : [x]);
            const ps = n(`${shape.value}/${i + 1}`);
            out.add(rdf.quad(shape, n(SH + 'property'), ps));
            out.add(rdf.quad(ps, n(SH + 'path'), n(path)));
            out.add(rdf.quad(ps, n(SH + 'name'), rdf.literal(ranges[0].name)));
            if (ranges[0].description) out.add(rdf.quad(ps, n(SH + 'description'), rdf.literal(ranges[0].description)));
            if (ranges.length === 1) return range(ps, ranges[0]);
            let list: Term = n(NS.rdf + 'nil');
            ranges.slice().reverse().forEach((x, j) => {
                const k = ranges.length - j, alt = n(`${ps.value}/or/${k}`), cell = n(`${ps.value}/or/${k}/list`);
                range(alt, x);
                out.add(rdf.quad(cell, n(NS.rdf + 'first'), alt));
                out.add(rdf.quad(cell, n(NS.rdf + 'rest'), list as never));
                list = cell;
            });
            out.add(rdf.quad(ps, n(SH + 'or'), list as never));
        });
    }
    return out;
}

const SKOS = NS.skos;

/** SKOS concept schemes and concepts in the shapes files. */
export function buildVocabulary(dataset: Dataset): { schemes: SchemeDef[]; concepts: ConceptDef[] } {
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
