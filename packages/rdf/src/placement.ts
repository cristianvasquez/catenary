// Which file has a subject, and where a new subject goes (ADR 0004): functions of the file graphs and the settings (settings.ts). Also
// the move of statements between files (`transfer`).

import { CommandResult, NS } from '@catenary/model';
import type { Term } from '@rdfjs/types';
import { NEAR, Placement } from './files';
import { ModelGraph, P, SKOS_TYPES, cmp, dataGraphIri, fileGraphIri, fileOfGraph, isVocabularyQuad } from './graph';
import { elementTerm, relationTriple } from './ids';
import type { Settings } from './settings';
import { shapesIndexOf } from './shapes-read';
import { rdf, tripleKey } from './terms';

/** The files of a subject (most statements first): its statements of the model graph and of shapes graphs. */
export function filesOfSubject(g: ModelGraph, t: Term): string[] {
    const count = new Map<string, number>();
    const add = (f: string) => count.set(f, (count.get(f) ?? 0) + 1);
    for (const q of g.match(t)) {
        if (g.isDataGraph(q.graph) && !q.graph.equals(g.model) || g.isShapesGraph(q.graph)) add(fileOfGraph(q.graph.value));
    }
    return [...count].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([f]) => f);
}

/** The file of a subject, else of the statements that refer to it (a new nested value). Undefined: nothing places it yet. */
export function nearFiles(g: ModelGraph, s: Term): Set<string> | undefined {
    const own = filesOfSubject(g, s);
    if (own.length) return new Set([own[0]]);
    for (const q of g.match(null, null, s)) {
        if (g.isDataGraph(q.graph) && !q.graph.equals(g.model) || g.isShapesGraph(q.graph)) return new Set([fileOfGraph(q.graph.value)]);
    }
    return undefined;
}

/**
 * The file of a new subject by the placement of its kind: the file of the placement, or "near". SKOS, "near": a concept or collection
 * goes to the file of its scheme (skos:inScheme, skos:topConceptOf, skos:member of a collection); other subjects, "near": the file with
 * most subjects of its class. `placeFile` turns the result (undefined: none found) into a file that can be written.
 */
export function placeOf(g: ModelGraph, placement: Placement, placeFile: (file: string | undefined) => string, s: Term): string {
    const types = g.match(s, P.type, null, g.model).map(q => q.object);
    const skos = types.some(t => SKOS_TYPES.some(k => k.equals(t))) || g.match(s, null, null, g.model).some(isVocabularyQuad);
    const place = skos ? placement.concepts : placement.instances;
    return placeFile(place !== NEAR ? place : skos ? nearScheme(g, s) : nearClass(g, types));
}

function nearScheme(g: ModelGraph, s: Term): string | undefined {
    const schemes = g.match(s, null, null, g.model)
        .filter(q => [NS.skos + 'inScheme', NS.skos + 'topConceptOf'].includes(q.predicate.value)).map(q => q.object);
    const collections = g.match(null, rdf.namedNode(NS.skos + 'member'), s, g.model).map(q => q.subject);
    for (const t of [...schemes, ...collections]) {
        const f = filesOfSubject(g, t)[0];
        if (f) return f;
    }
    return undefined;
}

function nearClass(g: ModelGraph, types: Term[]): string | undefined {
    const count = new Map<string, number>();
    for (const t of types) {
        for (const q of g.match(null, P.type, t).filter(q => g.isDataGraph(q.graph) && !q.graph.equals(g.model))) {
            const f = fileOfGraph(q.graph.value);
            count.set(f, (count.get(f) ?? 0) + 1);
        }
    }
    return [...count].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0];
}

/** Assign every new data statement its final file graph inside the command transaction. */
export function placeChanges(g: ModelGraph, settings: Settings): void {
    g.placePending((q, changes, fallback) => {
        const added = changes.find(c => c.op === 'add' && c.quad.graph.equals(g.model) && tripleKey(c.quad) === tripleKey(q));
        const prior = changes.filter(c => c.op === 'remove' && g.isDataGraph(c.quad.graph)
            && tripleKey(c.quad) === tripleKey(added?.was ?? q)).flatMap(c => settings.filesOfQuad(c.quad));
        const files = prior.length ? prior : [...nearFiles(g, q.subject) ?? []];
        if (!files.length && !fallback) return undefined;
        const place = () => placeOf(g, settings.placement, file => settings.placeFile(file), q.subject);
        return [...new Set((files.length ? files : [place()]).map(f => settings.writeProblemOf(f) ? settings.defaultFile : f))];
    });
}

/** Move the selected source quads into destination graphs inside one transaction. */
export function transfer(g: ModelGraph, settings: Settings, source: string, destination: string, ids: string[]): CommandResult {
    const problem = settings.transferProblem([source, destination]);
    if (problem) return { ok: false, error: problem };
    if (source === destination) return { ok: true };
    const index = shapesIndexOf(g);
    const subjects = new Set<string>();
    const relations = new Set<string>();
    for (const id of ids) {
        const rel = relationTriple(id);
        if (rel) relations.add(tripleKey(rdf.quad(rel.s, rel.p, rel.o)));
        else {
            const term = index.property.get(id)?.term ?? elementTerm(id);
            if (!term) return { ok: false, error: 'This element cannot move between files.' };
            subjects.add(term.value);
        }
    }
    const fromGraph = rdf.namedNode(fileGraphIri(source)), toGraph = rdf.namedNode(fileGraphIri(destination));
    const shapes = g.match(null, null, null, fromGraph);
    // Structural shape nodes travel with their selected parent. Referenced classes and named target shapes do not.
    const structural = new Set(['property', 'or', 'and', 'xone', 'not', 'qualifiedValueShape', 'path', 'inversePath', 'alternativePath', 'zeroOrMorePath', 'oneOrMorePath', 'zeroOrOnePath', 'in', 'languageIn', 'ignoredProperties'].map(p => NS.sh + p));
    structural.add(NS.rdf + 'first'); structural.add(NS.rdf + 'rest');
    for (let more = true; more;) {
        more = false;
        for (const q of shapes) if (subjects.has(q.subject.value) && structural.has(q.predicate.value) && q.object.termType === 'NamedNode'
            && !subjects.has(q.object.value) && shapes.some(s => s.subject.equals(q.object))) {
            subjects.add(q.object.value); more = true;
        }
    }
    if (shapes.some(q => structural.has(q.predicate.value) && subjects.has(q.object.value) && !subjects.has(q.subject.value))) {
        return { ok: false, error: 'A nested shape has an unselected parent. Select its parent shapes before moving it.' };
    }
    for (const q of shapes) if (subjects.has(q.subject.value) || relations.has(tripleKey(q))) {
        g.remove(q); g.add(q.subject, q.predicate, q.object, toGraph);
    }
    for (const q of g.match(null, null, null, rdf.namedNode(dataGraphIri(source)))) if (subjects.has(q.subject.value) || relations.has(tripleKey(q))) {
        g.remove(q); g.add(q.subject, q.predicate, q.object, rdf.namedNode(dataGraphIri(destination)));
    }
    return { ok: true };
}
