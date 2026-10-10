// The input of SHACL validation (ADR 0004, spec/manifest.hs §9 validationInput): the statements of the files that are not imported,
// the facts of the values they refer to, and the SKOS projection of all shapes graphs. ModelStore builds it; the validator (validate.ts)
// gets it as plain quads.

import { NS } from '@catenary/model';
import type { Quad } from '@rdfjs/types';
import { ModelGraph, P, dataGraphIri, isVocabularyQuad } from './graph';
import { Settings } from './settings';
import { rdf, termKey, tripleKey } from './terms';

const toTriple = (q: Quad) => rdf.quad(q.subject, q.predicate, q.object);
const skos = (local: string) => rdf.namedNode(NS.skos + local);
/** The facts of a referred IRI besides its statements (§9 factsOfTargets): its types and its scheme membership. */
const TARGET_FACTS = [P.type, skos('inScheme'), skos('topConceptOf')];

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
        for (const p of TARGET_FACTS) graph.match(o as Quad['subject'], p, null, graph.model).forEach(add);
        graph.match(null, skos('hasTopConcept'), o, graph.model).forEach(add);
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
