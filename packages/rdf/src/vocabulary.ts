// The Catenary vocabulary of the model graph: common predicates, the SKOS vocabulary, the RDFS rules, instances, labels and IRIs in
// use. Functions of a ModelGraph. This module fills graphRules (graph.ts) with metamodelQuad: graph.ts does not import it. It loads
// views.ts, so that one import of either module fills all the rules (the two modules import each other; they use the imports in
// functions only).

import { NS, RDFS_LABEL, RDF_TYPE, localName } from '@catenary/model';
import type { NamedNode, Quad, Term } from '@rdfjs/types';
import { nameFromURI, nameToURI } from 'canonical-md';
import { MODEL_GRAPH, ModelGraph, cmp, graphRules, sorted } from './graph';
import { isSkolem } from './skolem';
import { rdf } from './terms';
import { isView } from './views';

export const P = {
    type: rdf.namedNode(RDF_TYPE),
    label: rdf.namedNode(RDFS_LABEL),
    conformsTo: rdf.namedNode(NS.dct + 'conformsTo'),
    /** RDF 1.2: `r rdf:reifies <<( s p o )>>`. A placement of a connector is a reifier of its triple. */
    reifies: rdf.namedNode(NS.rdf + 'reifies')
};

/** Types of the SKOS vocabulary (see vocabularyQuads in shapes.ts). */
export const SKOS_TYPES = ['ConceptScheme', 'Concept', 'Collection'].map(t => rdf.namedNode(NS.skos + t));
/** Predicates that make a subject a SKOS concept without rdf:type (see vocabularySubjects). */
export const SKOS_MEMBERSHIP = ['inScheme', 'topConceptOf'].map(p => rdf.namedNode(NS.skos + p));
/** A quad of the model graph that changes the vocabulary: a SKOS predicate, or rdf:type of a SKOS class. */
export const isVocabularyQuad = (q: Quad) => q.predicate.value.startsWith(NS.skos) || (q.predicate.value === RDF_TYPE && q.object.value.startsWith(NS.skos));
/** Predicates of the RDFS rules (@catenary/rdfs domain-range.ts). */
const RDFS_PREDICATES = new Set(['domain', 'range', 'subClassOf'].map(p => NS.rdfs + p));
/** Text of a predicate or a class of an RDFS rule: its name and description in the metamodel. */
const RDFS_TEXT = new Set([NS.rdfs + 'label', NS.rdfs + 'comment', NS.skos + 'prefLabel']);
/** A quad of the model graph that can change the RDFS rules of the metamodel (without the text of the predicates and classes). */
export const isRdfsQuad = (q: Quad) => RDFS_PREDICATES.has(q.predicate.value) || (q.predicate.value === RDF_TYPE && q.object.value === NS.rdfs + 'Datatype');

/**
 * A quad of a data graph that changes the metamodel: the SKOS vocabulary, an RDFS rule, a statement of a SKOS subject, or the text of
 * a predicate or a class of an RDFS rule (GraphFacts.metamodelQuad).
 */
export function metamodelQuad(g: ModelGraph, q: Quad): boolean {
    return isVocabularyQuad(q) || isRdfsQuad(q)
        || SKOS_TYPES.some(t => g.match(q.subject, P.type, t, g.model).length > 0)
        || (RDFS_TEXT.has(q.predicate.value) && inRdfsRule(g, q.subject));
}

graphRules.metamodelQuad = metamodelQuad;

/**
 * A predicate or a class of an RDFS rule of the model graph: its label and comment are in the metamodel. A written subclass
 * counts too: the rules expand to it.
 */
function inRdfsRule(g: ModelGraph, t: Term): boolean {
    if (t.termType !== 'NamedNode') return false;
    return ['domain', 'range', 'subClassOf'].map(p => rdf.namedNode(NS.rdfs + p))
        .some(p => g.match(t as NamedNode, p, null, g.model).length > 0 || g.match(null, p, t as NamedNode, g.model).length > 0);
}

/**
 * Instance: an IRI in the model graph with an rdf:type or an rdfs:label (not the model graph IRI), or a SKOS subject of a shapes
 * graph (concept scheme, concept, collection). A resource is an instance whatever file holds it; `homeOf` gives the graph to edit.
 */
export function isInstance(g: ModelGraph, t: Term | undefined): t is NamedNode {
    return !!t && t.termType === 'NamedNode' && t.value !== MODEL_GRAPH && !t.equals(g.model) && (inModel(g, t) || !!vocabularyGraph(g, t));
}

/** An IRI with an rdf:type or an rdfs:label in the model graph. */
function inModel(g: ModelGraph, t: Term): boolean {
    return g.match(t, P.type, null, g.model).length > 0 || g.match(t, P.label, null, g.model).length > 0;
}

/** The shapes graph in which `t` is a SKOS subject (a SKOS type, skos:inScheme or skos:topConceptOf), first in order. */
function vocabularyGraph(g: ModelGraph, t: Term): NamedNode | undefined {
    const graphs = [
        ...SKOS_TYPES.flatMap(type => g.match(t, P.type, type)), ...SKOS_MEMBERSHIP.flatMap(p => g.match(t, p))
    ].map(q => q.graph).filter(graph => g.isShapesGraph(graph)) as NamedNode[];
    return sorted(graphs)[0];
}

/** The graph that holds the statements of an instance: the model graph, or the shapes graph of a SKOS subject of a shapes file. */
export function homeOf(g: ModelGraph, t: Term): NamedNode {
    return inModel(g, t) ? g.model : vocabularyGraph(g, t) ?? g.model;
}

/** SKOS subjects of the shapes graphs that are not instances of the model graph: IRI → its graph. Shapes graphs in order. */
export function vocabularySubjects(g: ModelGraph): Map<string, NamedNode> {
    const result = new Map<string, NamedNode>();
    for (const graph of g.shapesGraphs()) {
        const found = [...SKOS_TYPES.flatMap(t => g.match(null, P.type, t, graph)), ...SKOS_MEMBERSHIP.flatMap(p => g.match(null, p, null, graph))];
        for (const q of found) {
            if (q.subject.termType === 'NamedNode' && !result.has(q.subject.value) && !inModel(g, q.subject)) result.set(q.subject.value, graph);
        }
    }
    return result;
}

/** Label of an instance (graph: model) or a view (graph: the view). Several labels: the first in order. */
export function label(g: ModelGraph, t: Term, graph: Term = g.model): string {
    const labels = g.objects(t, P.label, graph).filter(o => o.termType === 'Literal').map(o => o.value).sort(cmp);
    return labels[0] ?? labelFromIri(t.value);
}

/**
 * Owned by `s`: an object IRI that was a blank node in its file (skolem.ts), is not an instance, has statements in `graph`, and that no other subject
 * refers to. A delete or copy of `s` includes it.
 */
export function ownedBy(g: ModelGraph, o: Term, s: Term, graph: Term): o is NamedNode {
    return isSkolem(o) && !isInstance(g, o) && g.match(o, null, null, graph).length > 0
        && g.match(null, null, o).every(q => q.subject.equals(s));
}

/** IRIs in use as model graph, view graph, subject of the model graph or of a shapes graph (for minting), except `except`. */
export function usedIris(g: ModelGraph, except?: Term): UsedIris {
    return new UsedIris(g, except);
}

/** Quads of the model graph in the default graph (for validation and the SHACL form). */
export function modelTriples(g: ModelGraph): Quad[] {
    return [...g.match(null, null, null, g.model)].map(q => rdf.quad(q.subject, q.predicate, q.object));
}

/**
 * The IRIs in use (usedIris), checked one IRI at a time: no set of all the IRIs of the dataset. `add`: an IRI that the
 * running edit minted and has not written yet.
 */
export class UsedIris {
    protected readonly added = new Set<string>();

    constructor(protected readonly g: ModelGraph, protected readonly except?: Term) {}

    has(iri: string): boolean {
        if (this.added.has(iri)) return true;
        if (this.except?.termType === 'NamedNode' && this.except.value === iri) return false;
        if (iri === MODEL_GRAPH || iri === this.g.model.value) return true;
        const t = rdf.namedNode(iri);
        return isView(this.g, t) || this.g.store.match(t).some(q => this.g.isDataGraph(q.graph) || this.g.isShapesGraph(q.graph));
    }

    add(iri: string): void {
        this.added.add(iri);
    }
}

export function mint(label: string): string {
    return nameToURI(label).value;
}

export function labelFromIri(value: string): string {
    return nameFromURI(rdf.namedNode(value)) ?? localName(value);
}
