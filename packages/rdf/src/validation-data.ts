// The input of SHACL validation (ADR 0004, spec/manifest.hs §9 validationInput): the statements of the files that are not imported,
// the facts of the values they refer to, and the SKOS projection of all shapes graphs. ValidationData builds it; the validator (validate.ts)
// gets it as plain quads.

import { NS, Violation } from '@catenary/model';
import type { Quad, Term } from '@rdfjs/types';
import { ModelGraph, P, V, dataGraphIri, isVocabularyQuad } from './graph';
import { elementId, elementTerm } from './ids';
import { Metamodel } from './shapes';
import { ShapesIndex } from './shapes-read';
import { ShaclResult, violationsOf } from './validate';
import { Settings } from './settings';
import { rdf, termKey, tripleKey } from './terms';

const toTriple = (q: Quad) => rdf.quad(q.subject, q.predicate, q.object);
const skos = (local: string) => rdf.namedNode(NS.skos + local);

/**
 * The triples that validation checks: the statements of the files that are not imported (with `focus`: of these subjects only), all
 * statements of their subjects, and the types and scheme membership of the IRIs they refer to. Undefined: no imported globs and no
 * focus, so validation reads the whole model graph.
 */
export function validationTriples(graph: ModelGraph, settings: Settings, focus?: Set<string>): Quad[] | undefined {
    if (!settings.importedGlobs.length && !focus) return undefined;
    const out = new Map<string, Quad>();
    for (const file of settings.modelFiles.keys()) {
        if (settings.isImported(file)) continue;
        for (const q of graph.match(null, null, null, rdf.namedNode(dataGraphIri(file)))) {
            if (!focus || focus.has(termKey(q.subject))) out.set(tripleKey(q), toTriple(q));
        }
    }
    const subjects = new Map<string, Quad['subject']>(), objects = new Map<string, Quad['object']>();
    for (const q of out.values()) {
        subjects.set(termKey(q.subject), q.subject);
        if (q.object.termType === 'NamedNode') objects.set(termKey(q.object), q.object);
    }
    const add = (q: Quad) => { const t = toTriple(q); out.set(tripleKey(t), t); };
    for (const s of subjects.values()) graph.match(s, null, null, graph.model).forEach(add);
    for (const [k, o] of objects) {
        if (subjects.has(k)) continue;
        // Its types and schemes only, as skos:inScheme: a statement with the referred IRI or its scheme as subject would make it a
        // focus node of shapes that target that predicate, without its other statements.
        const s = o as Quad['subject'];
        graph.match(s, P.type, null, graph.model).forEach(add);
        graph.match(s, skos('inScheme'), null, graph.model).forEach(add);
        for (const q of graph.match(s, skos('topConceptOf'), null, graph.model)) add(rdf.quad(s, skos('inScheme'), q.object));
        for (const q of graph.match(null, skos('hasTopConcept'), s, graph.model)) add(rdf.quad(s, skos('inScheme'), q.subject));
    }
    return [...out.values()];
}

/** The skos:inScheme that skos:topConceptOf and skos:hasTopConcept imply (§9 schemeMembership), with `quads`, as triples. */
export function schemeMembership(quads: Iterable<Quad>): Quad[] {
    const out = new Map<string, Quad>();
    const add = (q: Quad) => { const t = toTriple(q); out.set(tripleKey(t), t); };
    for (const q of quads) {
        add(q);
        if (q.predicate.value === NS.skos + 'topConceptOf') add(rdf.quad(q.subject, skos('inScheme'), q.object));
        else if (q.predicate.value === NS.skos + 'hasTopConcept' && q.object.termType === 'NamedNode') add(rdf.quad(q.object, skos('inScheme'), q.subject));
    }
    return [...out.values()];
}

/**
 * The SKOS projection of shapes triples (§9 skosProjection): the statements with a SKOS predicate and rdf:type of a SKOS class, with
 * the scheme membership they imply. `named`: only the statements about these IRIs (termKey), the mode OpenViews.
 */
export function skosProjection(shapes: Iterable<Quad>, named?: Set<string>): Quad[] {
    const projection = schemeMembership([...shapes].filter(isVocabularyQuad));
    return named ? projection.filter(q => named.has(termKey(q.subject))) : projection;
}

/**
 * The data of a run (§9 validationInput): `data` (validationTriples, or the model graph), and the SKOS projection of `shapes`, all
 * shapes graphs. With `focus` (the mode OpenViews): the projection only about the focus and the IRIs that `data` names.
 */
export function validationInput(data: Quad[], shapes: Iterable<Quad>, focus?: Set<string>): Quad[] {
    let named: Set<string> | undefined;
    if (focus) {
        named = new Set(focus);
        for (const q of data) for (const t of [q.subject, q.object]) if (t.termType === 'NamedNode') named.add(termKey(t));
    }
    return schemeMembership([...data, ...skosProjection(shapes, named)]);
}

/** Live validation state supplied by the coordinator. No file queue access. */
export interface ValidationContext {
    graph: ModelGraph;
    settings?: Settings;
    metamodel: Metamodel;
    shapesIndex(): ShapesIndex;
}

/** Open editors, run input and checked-instance count. Kept across dataset replacements. */
export class ValidationData {
    protected readonly openViews = new Map<string, string>();
    validated?: number;
    constructor(private readonly ctx: ValidationContext, private readonly invalidate: () => void) {}
    private get graph() { return this.ctx.graph; }
    private get settings() { return this.ctx.settings; }
    stamp(): string { return `${this.settings?.validation}:${this.validated ?? ''}`; }

    /**
     * An editor (`client`) shows `viewId`, or (undefined) closed. In the validation mode "views", a change of the set of open views
     * starts a validation.
     */
    setOpenView(client: string, viewId: string | undefined): void {
        const before = this.openViewIris().join('\n');
        if (viewId) this.openViews.set(client, viewId); else this.openViews.delete(client);
        if (this.settings?.validation === 'views' && this.openViewIris().join('\n') !== before) this.invalidate();
    }

    /** The IRIs of the open views, sorted, without duplicates. */
    openViewIris(): string[] {
        return [...new Set([...this.openViews.values()].map(v => elementTerm(v)?.value).filter((v): v is string => !!v))].sort();
    }

    /**
     * The elements on the open views (spec/manifest.hs §9 `validationFocus`), by termKey: the elements of placements, the subjects of
     * placed relations, and the members of groups.
     */
    protected validationFocus(): Map<string, Term> {
        const focus = new Map<string, Term>();
        const add = (t: Term) => { if (t.termType === 'NamedNode') focus.set(termKey(t), t); };
        for (const iri of this.openViewIris()) {
            const g = rdf.namedNode(iri);
            for (const q of this.graph.store.match(null, V.element, null, g)) add(q.object);
            for (const q of this.graph.store.match(null, V.member, null, g)) add(q.object);
            for (const q of this.graph.store.match(null, P.reifies, null, g)) if (q.object.termType === 'Quad') add(q.object.subject);
        }
        return focus;
    }

    /**
     * The input of the validator by the validation mode (§9 validationInput; undefined: off): the data (validation-data.ts) with the SKOS
     * projection, and all shapes graphs, own and imported. The validator gets plain quads; it reads nothing from the store.
     */
    validationInput(): { data: Quad[]; shapes: Quad[] } | undefined {
        const mode = this.settings?.validation;
        if (mode === 'off') return undefined;
        const shapes = this.graph.shapesTriples();
        if (mode !== 'views') {
            this.validated = undefined;
            return { data: validationInput((this.settings && validationTriples(this.graph, this.settings)) ?? this.graph.modelTriples(), shapes), shapes };
        }
        const focus = this.validationFocus(), keys = new Set(focus.keys());
        const data = validationTriples(this.graph, this.settings!, keys) ?? [];
        // Checked: an instance on an open view with statements in the data (not one that only imported files describe).
        const subjects = new Set(data.map(q => termKey(q.subject)));
        this.validated = [...focus].filter(([k, t]) => subjects.has(k) && this.graph.isInstance(t)).length;
        return { data: validationInput(data, shapes, keys), shapes };
    }

    /** The violations of a run, with the element ids of the dataset after the run (a change during the run made it stale). */
    violationsOf(results: ShaclResult[]): Violation[] {
        const idx = this.ctx.shapesIndex();
        return violationsOf(results, this.ctx.metamodel, iri => {
            const t = rdf.namedNode(iri);
            return this.graph.isInstance(t) ? elementId(t) : undefined;
        }, t => idx.byTerm.get(termKey(t)));
    }

}
