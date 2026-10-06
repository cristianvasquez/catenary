// Which file has a subject, and where a new subject goes (ADR 0004). Pure functions of the dataset and of `origin` (the files of each
// statement of the model graph).

import { NS } from '@catenary/model';
import type { Term } from '@rdfjs/types';
import { NEAR, Placement } from './files';
import { ModelGraph, P, SKOS_TYPES, cmp, fileOfGraph, isVocabularyQuad } from './graph';
import { rdf, tripleKey } from './terms';

/** Statement of the model graph (tripleKey) -> the files that have it. */
export type Origin = ReadonlyMap<string, ReadonlySet<string>>;

/** The files of a subject (most statements first): its statements of the model graph and of shapes graphs. */
export function filesOfSubject(g: ModelGraph, origin: Origin, t: Term): string[] {
    const count = new Map<string, number>();
    const add = (f: string) => count.set(f, (count.get(f) ?? 0) + 1);
    for (const q of g.match(t)) {
        if (q.graph.equals(g.model)) origin.get(tripleKey(q))?.forEach(add);
        else if (g.isShapesGraph(q.graph)) add(fileOfGraph(q.graph.value));
    }
    return [...count].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([f]) => f);
}

/** The file of a subject, else of the statements that refer to it (a new nested value). Undefined: nothing places it yet. */
export function nearFiles(g: ModelGraph, origin: Origin, s: Term): Set<string> | undefined {
    const own = filesOfSubject(g, origin, s);
    if (own.length) return new Set([own[0]]);
    for (const q of g.match(null, null, s)) {
        if (q.graph.equals(g.model)) {
            const o = origin.get(tripleKey(q));
            if (o?.size) return new Set([[...o].sort()[0]]);
        } else if (g.isShapesGraph(q.graph)) return new Set([fileOfGraph(q.graph.value)]);
    }
    return undefined;
}

/**
 * The file of a new subject by the placement of its kind: the file of the placement, or "near". SKOS, "near": a concept or collection
 * goes to the file of its scheme (skos:inScheme, skos:topConceptOf, skos:member of a collection); other subjects, "near": the file with
 * most subjects of its class. `placeFile` turns the result (undefined: none found) into a file that can be written.
 */
export function placeOf(g: ModelGraph, origin: Origin, placement: Placement, placeFile: (file: string | undefined) => string, s: Term): string {
    const types = g.match(s, P.type, null, g.model).map(q => q.object);
    const skos = types.some(t => SKOS_TYPES.some(k => k.equals(t))) || g.match(s, null, null, g.model).some(isVocabularyQuad);
    const place = skos ? placement.concepts : placement.instances;
    return placeFile(place !== NEAR ? place : skos ? nearScheme(g, origin, s) : nearClass(g, origin, types));
}

function nearScheme(g: ModelGraph, origin: Origin, s: Term): string | undefined {
    const schemes = g.match(s, null, null, g.model)
        .filter(q => [NS.skos + 'inScheme', NS.skos + 'topConceptOf'].includes(q.predicate.value)).map(q => q.object);
    const collections = g.match(null, rdf.namedNode(NS.skos + 'member'), s, g.model).map(q => q.subject);
    for (const t of [...schemes, ...collections]) {
        const f = filesOfSubject(g, origin, t)[0];
        if (f) return f;
    }
    return undefined;
}

function nearClass(g: ModelGraph, origin: Origin, types: Term[]): string | undefined {
    const count = new Map<string, number>();
    for (const t of types) {
        for (const q of g.match(null, P.type, t, g.model)) {
            for (const f of origin.get(tripleKey(q)) ?? []) count.set(f, (count.get(f) ?? 0) + 1);
        }
    }
    return [...count].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0];
}
