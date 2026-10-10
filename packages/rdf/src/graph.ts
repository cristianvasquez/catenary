// The model as quads in a QuadStore (store.ts): one store graph for each file (ADR 0003). The data file: the model graph; each shapes
// file: a shapes graph; both named `urn:file:<path>`. Workspace files: one named graph for each view, with the graph names of the file.
// The role of a graph comes from the registry of this class (`model`, `setShapesGraphs`), not from its name.
// The store is the source of truth. Every change goes through `add` / `remove`, which record a patch:
// a transaction gives one patch, undo applies the patch backwards. Element ids: see ids.ts.

import { MigrationChange, NS, RDFS_LABEL, RDF_TYPE, localName } from '@catenary/model';
import type { TermSet } from 'rdf-ext';
import type { NamedNode, Quad, Quad_Graph, Quad_Object, Quad_Predicate, Quad_Subject, Term } from '@rdfjs/types';
import { nameFromURI, nameToURI } from 'canonical-md';
import { createHash, randomBytes } from 'crypto';
import type { QuadStore } from 'rdf-files';
import { isSkolem } from './skolem';
import { rdf, termKey } from './terms';

/**
 * The model resource (subject of dct:conformsTo and the label of the model, in the data file), the graph name of the data in TriG text
 * (workspace files, test fixtures), and the model graph when there is no data file.
 */
export const MODEL_GRAPH = 'urn:name:model';
/** The SHACL report of the last validation (ADR 0007): derived, not saved, not in undo, not in the canonical form. */
export const VALIDATION_GRAPH = 'urn:trellis:validation';

/** Store graph of a file: this prefix and the encoded absolute path. */
export const FILE_GRAPH_PREFIX = 'urn:file:';
export const fileGraphIri = (file: string) => FILE_GRAPH_PREFIX + encodeURI(file);
/** File of a store graph (its path), or the graph IRI when it has no path. */
export const fileOfGraph = (graph: string) => {
    const rest = graph.startsWith(FILE_GRAPH_PREFIX) ? graph.slice(FILE_GRAPH_PREFIX.length) : graph;
    try { return decodeURI(rest); } catch { return rest; }
};

/** Types of the SKOS vocabulary (see ModelGraph.vocabularyQuads). */
export const SKOS_TYPES = ['ConceptScheme', 'Concept', 'Collection'].map(t => rdf.namedNode(NS.skos + t));
/** Predicates that make a subject a SKOS concept without rdf:type (see ModelGraph.vocabularySubjects). */
export const SKOS_MEMBERSHIP = ['inScheme', 'topConceptOf'].map(p => rdf.namedNode(NS.skos + p));
/** A quad of the model graph that changes the vocabulary: a SKOS predicate, or rdf:type of a SKOS class. */
export const isVocabularyQuad = (q: Quad) => q.predicate.value.startsWith(NS.skos) || (q.predicate.value === RDF_TYPE && q.object.value.startsWith(NS.skos));
/** Predicates of the RDFS rules (@catenary/rdfs domain-range.ts). */
const RDFS_PREDICATES = new Set(['domain', 'range', 'subClassOf'].map(p => NS.rdfs + p));
/** Text of a predicate or a class of an RDFS rule: its name and description in the metamodel. */
const RDFS_TEXT = new Set([NS.rdfs + 'label', NS.rdfs + 'comment', NS.skos + 'prefLabel']);
/** A quad of the model graph that can change the RDFS rules of the metamodel (without the text of the predicates and classes). */
export const isRdfsQuad = (q: Quad) => RDFS_PREDICATES.has(q.predicate.value) || (q.predicate.value === RDF_TYPE && q.object.value === NS.rdfs + 'Datatype');

export const P = {
    type: rdf.namedNode(RDF_TYPE),
    label: rdf.namedNode(RDFS_LABEL),
    conformsTo: rdf.namedNode(NS.dct + 'conformsTo'),
    /** RDF 1.2: `r rdf:reifies <<( s p o )>>`. A placement of a connector is a reifier of its triple. */
    reifies: rdf.namedNode(NS.rdf + 'reifies')
};

/** The view vocabulary. */
export const V = {
    View: rdf.namedNode(NS.view + 'View'),
    Placement: rdf.namedNode(NS.view + 'Placement'),
    // Marks (spec/ui-manifest.hs §2.2): elements of the Project layer, kept by their placements. A mark holds its content; its
    // placements hold box and color. The statements of a mark are in the view file of the view where it was made.
    /** A label; what is inside is computed from the geometry of one view. */
    Frame: rdf.namedNode(NS.view + 'Frame'),
    /** Markdown text (`view:text`). */
    Note: rdf.namedNode(NS.view + 'Note'),
    /** A link to a file (ADR 0004): `view:file`, the path relative to the view file. */
    FileRef: rdf.namedNode(NS.view + 'FileRef'),
    file: rdf.namedNode(NS.view + 'file'),
    /** A group of entities (`view:member`). */
    EntityGroup: rdf.namedNode(NS.view + 'EntityGroup'),
    /** An arrow: the statement `x view:arrow y` (Project layer, visual only), kept by its placements. */
    arrow: rdf.namedNode(NS.view + 'arrow'),
    member: rdf.namedNode(NS.view + 'member'),
    element: rdf.namedNode(NS.view + 'element'),
    /** The view of a placement: `p view:element e ; view:view v` is a placement of e in v. */
    view: rdf.namedNode(NS.view + 'view'),
    text: rdf.namedNode(NS.view + 'text'),
    description: rdf.namedNode(NS.view + 'description'),
    x: rdf.namedNode(NS.view + 'x'),
    y: rdf.namedNode(NS.view + 'y'),
    width: rdf.namedNode(NS.view + 'width'),
    height: rdf.namedNode(NS.view + 'height'),
    color: rdf.namedNode(NS.view + 'color'),
    /** Content of a card: "simple" (class and name). Absent: detailed. */
    display: rdf.namedNode(NS.view + 'display'),
    fromSide: rdf.namedNode(NS.view + 'fromSide'),
    toSide: rdf.namedNode(NS.view + 'toSide'),
    /** On a box placement (true): the box leaves with its last line (ADR 0014, a box that a line or hub brought). */
    keptByLines: rdf.namedNode(NS.view + 'keptByLines')
};

/** `was`: on an add, the statement that it replaces (an IRI change); the store keeps the files of that statement. */
export type Change = { op: 'add' | 'remove'; quad: Quad; was?: Quad };

/** The changes of one transaction, in order. */
export type Patch = Change[];

type Maybe<T> = T | null | undefined;

export class ModelGraph {
    /** The model graph: the store graph of the data file. */
    model: NamedNode = rdf.namedNode(MODEL_GRAPH);

    /** The shapes graphs: the store graphs of the shapes files. */
    protected shapes: TermSet<NamedNode> = rdf.termSet<NamedNode>();

    protected log?: Patch;

    /** Shapes graph that gets new node shapes (the primary shapes file). Undefined: the first shapes graph. */
    primaryShapes?: NamedNode;

    /** Data changes that the shape edits of the open transaction ask for (the store puts them in its queue). */
    proposed: { change: MigrationChange; reason: string }[] = [];

    /**
     * Changes each time the content of `shapesAndVocabulary` or the RDFS rules can change: a quad of a shapes graph, a SKOS
     * statement or a statement of a SKOS subject of the model graph, an RDFS statement (isRdfsQuad) or the text of an RDFS
     * predicate or class, the shapes graphs. It keys the cache of the shapes index (shape-ops.ts). A change of the store that does not use `add`, `remove`
     * or a patch (a read of a file) must call `shapesChanged`.
     */
    shapesRevision = 0;
    /** Source-model and shapes changes. View and report graph edits do not change SHACL target data. */
    queryRevision = 0;

    shapesChanged(): void {
        this.shapesRevision++;
        this.queryRevision++;
    }

    protected count(q: Quad): void {
        if (q.graph.equals(this.model) || this.shapes.has(q.graph as NamedNode) || (q.predicate.equals(P.type) && q.object.equals(V.View))) this.queryRevision++;
        if (this.shapes.has(q.graph as NamedNode)) this.shapesRevision++;
        else if (q.graph.equals(this.model) && (isVocabularyQuad(q) || isRdfsQuad(q) || SKOS_TYPES.some(t => this.store.match(q.subject, P.type, t, this.model).length > 0)
            || (RDFS_TEXT.has(q.predicate.value) && this.inRdfsRule(q.subject)))) this.shapesRevision++;
    }

    constructor(readonly store: QuadStore) {}

    /** A predicate or a class of an RDFS rule of the model graph: its label and comment are in the metamodel. */
    protected inRdfsRule(t: Term): boolean {
        if (t.termType !== 'NamedNode') return false;
        const [domain, range] = [rdf.namedNode(NS.rdfs + 'domain'), rdf.namedNode(NS.rdfs + 'range')];
        return [domain, range].some(p => this.store.match(t as NamedNode, p, null, this.model).length > 0 || this.store.match(null, p, t as NamedNode, this.model).length > 0);
    }

    setShapesGraphs(graphs: Iterable<NamedNode>): void {
        this.shapes = rdf.termSet([...graphs]);
        this.shapesRevision++;
        this.queryRevision++;
    }

    isShapesGraph(t: Term | undefined): boolean {
        return !!t && t.termType === 'NamedNode' && this.shapes.has(t);
    }

    has(q: Quad): boolean {
        return this.store.has(q);
    }

    match(s?: Maybe<Term>, p?: Maybe<Term>, o?: Maybe<Term>, g?: Maybe<Term>): Quad[] {
        return this.store.match(s, p, o, g);
    }

    /** All quads. */
    quads(): Quad[] {
        return this.store.match();
    }

    // ------------------------------------------------------------ changes

    /** `was`: the statement that this one replaces (see Change.was). */
    add(s: Quad_Subject, p: Quad_Predicate, o: Quad_Object, g: Quad_Graph = this.model, was?: Quad): void {
        const q = rdf.quad(s, p, o, g);
        if (this.store.has(q)) return;
        this.store.add(q);
        this.count(q);
        this.log?.push(was ? { op: 'add', quad: q, was } : { op: 'add', quad: q });
    }

    remove(q: Quad): void {
        if (!this.store.has(q)) return;
        this.store.delete(q);
        this.count(q);
        this.log?.push({ op: 'remove', quad: q });
    }

    removeMatches(s?: Maybe<Term>, p?: Maybe<Term>, o?: Maybe<Term>, g?: Maybe<Term>): void {
        for (const q of [...this.store.match(s, p, o, g)]) this.remove(q);
    }

    /** Replace the objects of (s, p) in graph g. Undefined removes them. */
    set(s: Quad_Subject, p: Quad_Predicate, o: Quad_Object | undefined, g: Quad_Graph = this.model): void {
        for (const q of [...this.store.match(s, p, null, g)]) if (!o || !q.object.equals(o)) this.remove(q);
        if (o) this.add(s, p, o, g);
    }

    /**
     * Run `fn` as one transaction and return its result with the patch of its changes.
     * An error result or an exception reverts the changes (the patch is then empty).
     */
    transact<R extends { ok: boolean }>(fn: (g: this) => R): { result: R | { ok: false; error: string }; patch: Patch } {
        if (this.log) throw new Error('A transaction is already open.');
        const log: Patch = this.log = [];
        this.proposed = [];
        let result: R | { ok: false; error: string };
        try {
            result = fn(this);
        } catch (e) {
            result = { ok: false, error: (e as Error).message };
        } finally {
            this.log = undefined;
        }
        if (result.ok) return { result, patch: log };
        this.proposed = [];
        this.undo(log);
        return { result, patch: [] };
    }

    /** The changes of the open transaction so far (empty outside a transaction). */
    changes(): readonly Change[] {
        return this.log ?? [];
    }

    undo(patch: Patch): void {
        for (let i = patch.length - 1; i >= 0; i--) this.applyChange(patch[i], true);
    }

    redo(patch: Patch): void {
        for (const c of patch) this.applyChange(c, false);
    }

    protected applyChange(c: Change, backwards: boolean): void {
        if ((c.op === 'add') !== backwards) this.store.add(c.quad);
        else this.store.delete(c.quad);
        this.count(c.quad);
    }

    // ------------------------------------------------------------ reads

    objects(s: Term, p: Term, g: Maybe<Term> = this.model): Quad_Object[] {
        return [...this.store.match(s, p, null, g)].map(q => q.object);
    }

    /** The first object in term order: a stable choice when there are several. */
    object(s: Term, p: Term, g: Maybe<Term> = this.model): Quad_Object | undefined {
        return this.objects(s, p, g).sort((a, b) => cmp(a.value, b.value))[0];
    }

    subjects(p: Term, o: Maybe<Term>, g: Maybe<Term> = this.model): Quad_Subject[] {
        return [...this.store.match(null, p, o, g)].map(q => q.subject);
    }

    number(s: Term, p: Term, g: Term, fallback: number): number {
        const v = this.object(s, p, g)?.value;
        return v === undefined || isNaN(Number(v)) ? fallback : Number(v);
    }

    /**
     * Instance: an IRI in the model graph with an rdf:type or an rdfs:label (not the model graph IRI), or a SKOS subject of a shapes
     * graph (concept scheme, concept, collection). A resource is an instance whatever file holds it; `homeOf` gives the graph to edit.
     */
    isInstance(t: Term | undefined): t is NamedNode {
        return !!t && t.termType === 'NamedNode' && t.value !== MODEL_GRAPH && !t.equals(this.model) && (this.inModel(t) || !!this.vocabularyGraph(t));
    }

    /** An IRI with an rdf:type or an rdfs:label in the model graph. */
    protected inModel(t: Term): boolean {
        return this.store.match(t, P.type, null, this.model).length > 0 || this.store.match(t, P.label, null, this.model).length > 0;
    }

    /** The shapes graph in which `t` is a SKOS subject (a SKOS type, skos:inScheme or skos:topConceptOf), first in order. */
    protected vocabularyGraph(t: Term): NamedNode | undefined {
        const graphs = [
            ...SKOS_TYPES.flatMap(type => this.store.match(t, P.type, type)), ...SKOS_MEMBERSHIP.flatMap(p => this.store.match(t, p))
        ].map(q => q.graph).filter(g => this.isShapesGraph(g)) as NamedNode[];
        return sorted(graphs)[0];
    }

    /** The graph that holds the statements of an instance: the model graph, or the shapes graph of a SKOS subject of a shapes file. */
    homeOf(t: Term): NamedNode {
        return this.inModel(t) ? this.model : this.vocabularyGraph(t) ?? this.model;
    }

    /** SKOS subjects of the shapes graphs that are not instances of the model graph: IRI → its graph. Shapes graphs in order. */
    vocabularySubjects(): Map<string, NamedNode> {
        const result = new Map<string, NamedNode>();
        for (const graph of this.shapesGraphs()) {
            const found = [...SKOS_TYPES.flatMap(t => this.store.match(null, P.type, t, graph)), ...SKOS_MEMBERSHIP.flatMap(p => this.store.match(null, p, null, graph))];
            for (const q of found) {
                if (q.subject.termType === 'NamedNode' && !result.has(q.subject.value) && !this.inModel(q.subject)) result.set(q.subject.value, graph);
            }
        }
        return result;
    }

    /** View: a named graph (not the model graph) with a view:View subject. */
    isView(g: Term | undefined): boolean {
        return !!g && g.termType === 'NamedNode' && !g.equals(this.model) && this.store.match(null, P.type, V.View, g).length > 0;
    }

    /** View graph IRIs, sorted. */
    views(): NamedNode[] {
        const seen = rdf.termSet<NamedNode>();
        for (const q of this.store.match(null, P.type, V.View)) if (this.isView(q.graph)) seen.add(q.graph as NamedNode);
        return sorted(seen);
    }

    /** Label of an instance (graph: model) or a view (graph: the view). Several labels: the first in order. */
    label(t: Term, g: Term = this.model): string {
        const labels = this.objects(t, P.label, g).filter(o => o.termType === 'Literal').map(o => o.value).sort(cmp);
        return labels[0] ?? labelFromIri(t.value);
    }

    /** The view:View subject of a view graph (normally the graph IRI). */
    viewSubject(g: Term): Quad_Subject | undefined {
        return this.subjects(P.type, V.View, g).sort((a, b) => cmp(a.value, b.value))[0];
    }

    /** The view:Placement of an instance in a view. */
    nodeOf(g: Term, instance: Term): Quad_Subject | undefined {
        return this.subjects(V.element, instance, g).find(s => this.store.has(rdf.quad(s, P.type, V.Placement, g as Quad_Graph)));
    }

    /** The placement of a connector (a relation, an arrow) in a view: the placement that reifies the triple `s p o`. */
    edgeOf(g: Term, s: Term, p: Term, o: Term): Quad_Subject | undefined {
        return this.subjects(P.reifies, rdf.quad(s as Quad_Subject, p as Quad_Predicate, o as Quad_Object), g).find(e => this.store.has(rdf.quad(e, P.type, V.Placement, g as Quad_Graph)));
    }

    /** The triple of a placement of a connector in view graph `g` (the triple term that it reifies), or undefined. */
    connectorOf(placement: Term, g: Term): Quad | undefined {
        const t = this.store.match(placement, P.reifies, null, g).find(q => q.object.termType === 'Quad')?.object;
        return t as Quad | undefined;
    }

    /** The placements of connectors in view graph `g` (all views: undefined), with their triples. */
    connectorPlacements(g?: Term): { placement: Quad_Subject; triple: Quad; view: NamedNode }[] {
        return this.store.match(null, P.reifies, null, g ?? null)
            .filter(q => q.object.termType === 'Quad' && this.store.has(rdf.quad(q.subject, P.type, V.Placement, q.graph)))
            .map(q => ({ placement: q.subject, triple: q.object as Quad, view: q.graph as NamedNode }));
    }

    /** The placements of view graph `g` whose element has the type `type` (a mark), or is a view (`V.View`: view references). */
    placementsOf(g: Term, type: NamedNode): Quad_Subject[] {
        return this.subjects(P.type, V.Placement, g).filter(p => {
            const e = this.store.match(p, V.element, null, g)[0]?.object;
            if (!e || e.termType !== 'NamedNode') return false;
            return type.equals(V.View) ? this.isView(e) : this.store.match(e, P.type, type).length > 0;
        });
    }

    groups(g: Term): Quad_Subject[] {
        return this.placementsOf(g, V.Frame);
    }

    notes(g: Term): Quad_Subject[] {
        return this.placementsOf(g, V.Note);
    }

    /** The placements of arrows in view graph `g`. */
    arrows(g: Term): Quad_Subject[] {
        return this.connectorPlacements(g).filter(c => c.triple.predicate.equals(V.arrow)).map(c => c.placement);
    }

    /** Shapes graph IRIs that have quads, sorted. */
    shapesGraphs(): NamedNode[] {
        return sorted([...this.shapes].filter(g => this.store.match(null, null, null, g).length > 0));
    }

    /**
     * The graph for new node shapes: the primary shapes graph, else the first one. The primary graph can be empty (an empty
     * shapes file): shapesGraphs() finds only graphs with quads.
     */
    shapesTarget(): NamedNode | undefined {
        return this.primaryShapes ?? this.shapesGraphs()[0];
    }

    /** Quads of all shapes graphs, with their graphs. */
    shapesQuads(): Quad[] {
        return this.shapesGraphs().flatMap(sg => this.store.match(null, null, null, sg));
    }

    /**
     * SKOS vocabulary of the model graph: the statements of its concept schemes, concepts and collections (subjects with one of these
     * types), with their graph. Concepts in the data file are instances too; the shapes read and the metamodel also use these quads.
     */
    vocabularyQuads(): Quad[] {
        const subjects = rdf.termSet<Term>();
        for (const t of SKOS_TYPES) for (const q of this.store.match(null, P.type, t, this.model)) subjects.add(q.subject);
        return [...subjects].flatMap(s => this.store.match(s as Quad_Subject, null, null, this.model));
    }

    /** Shapes quads and the SKOS vocabulary of the model graph. */
    shapesAndVocabulary(): Quad[] {
        return [...this.shapesQuads(), ...this.vocabularyQuads()];
    }

    /** Triples of all shapes graphs (the union of the shapes files). */
    shapesTriples(): Quad[] {
        return this.shapesQuads().map(q => rdf.quad(q.subject, q.predicate, q.object));
    }

    /** A new mark IRI: `<view>/m/<id>`, `id` 6 random base-36 characters. */
    markIri(view: NamedNode): NamedNode {
        for (;;) {
            const t = newMarkIri(view.value);
            if (!this.store.match(t).length && !this.store.match(null, null, t).length) return t;
        }
    }

    /**
     * Owned by `s`: an object IRI that was a blank node in its file (skolem.ts), is not an instance, has statements in `graph`, and that no other subject
     * refers to. A delete or copy of `s` includes it.
     */
    ownedBy(o: Term, s: Term, graph: Term): o is NamedNode {
        return isSkolem(o) && !this.isInstance(o) && this.store.match(o, null, null, graph).length > 0
            && this.store.match(null, null, o).every(q => q.subject.equals(s));
    }

    /** IRIs in use as model graph, view graph, subject of the model graph or of a shapes graph (for minting), except `except`. */
    usedIris(except?: Term): UsedIris {
        return new UsedIris(this, except);
    }

    /** Quads of the model graph in the default graph (for validation and the SHACL form). */
    modelTriples(): Quad[] {
        return [...this.store.match(null, null, null, this.model)].map(q => rdf.quad(q.subject, q.predicate, q.object));
    }
}

/** The IRIs of the elements of a view: placements (`p`) and marks (`m`). */
export type ViewPart = 'p' | 'm';
/**
 * The IRIs in use (ModelGraph.usedIris), checked one IRI at a time: no set of all the IRIs of the dataset. `add`: an IRI that the
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
        return this.g.isView(t) || this.g.store.match(t).some(q => q.graph.equals(this.g.model) || this.g.isShapesGraph(q.graph));
    }

    add(iri: string): void {
        this.added.add(iri);
    }
}

export const viewPartBase = (view: string, part: ViewPart) => `${view}/${part}/`;
/** `<view>/m/<id>`, `id` 6 random base-36 characters (ModelGraph.markIri checks that it is free). */
export const newMarkIri = (view: string): NamedNode => rdf.namedNode(viewPartBase(view, 'm') + [...randomBytes(6)].map(b => (b % 36).toString(36)).join(''));

/**
 * The IRI of the placement of `placed` (an element, or a triple for a connector) in `view`: `<view>/p/<hash>`, 12 hex characters of the
 * placed term. A view places an element or a triple at most once, so the IRI is unique and the same at each placement.
 */
export const placementIri = (view: string, placed: Term): NamedNode =>
    rdf.namedNode(viewPartBase(view, 'p') + createHash('sha256').update(termKey(placed)).digest('hex').slice(0, 12));

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Terms sorted by value. */
export function sorted<T extends Term>(terms: Iterable<T>): T[] {
    return [...terms].sort((a, b) => cmp(a.value, b.value));
}

export function mint(label: string): string {
    return nameToURI(label).value;
}

export function labelFromIri(value: string): string {
    return nameFromURI(rdf.namedNode(value)) ?? localName(value);
}
