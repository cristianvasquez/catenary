// The data that SHACL validation reads (ADR 0004, spec/manifest.hs §9): the statements of the files that are not imported, and the
// types of the values they refer to. Moves to the validator in stage 4 (draft/sync-refactor).

import type { Quad } from '@rdfjs/types';
import { ModelGraph, P, dataGraphIri } from './graph';
import { Settings } from './settings';
import { rdf, termKey, tripleKey } from './terms';

const toTriple = (q: Quad) => rdf.quad(q.subject, q.predicate, q.object);

/**
 * The triples that validation checks: the statements of the files that are not imported (with `focus`: of these subjects only), all
 * statements of their subjects, and the types of the IRIs they refer to. Undefined: no imported globs and no focus, so validation
 * reads the whole model graph.
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
    for (const [k, o] of objects) if (!subjects.has(k)) graph.match(o as Quad['subject'], P.type, null, graph.model).forEach(add);
    return [...out.values()];
}
