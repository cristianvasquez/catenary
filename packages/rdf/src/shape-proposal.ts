// Node shapes proposed from the data (SHACLxtract): for classes of the model graph that no node shape targets. The extraction reads the
// model graph; the shapes go to the primary shapes file. As at every file read, the blank nodes of the extracted shapes get skolem IRIs
// (skolem.ts). The proposal describes the data; it does not establish rules.

import { NS } from '@catenary/model';
import type { NamedNode, Quad } from '@rdfjs/types';
import { extractShapes } from 'shaclxtract';
import { ModelGraph, P } from './graph';
import { elementId } from './ids';
import { Result, fail, ok } from './ops';
import { mintShapeIri } from './shape-ops';
import { S } from './shapes-read';
import { skolemize } from './skolem';
import { rdf } from './terms';

/** Types that get no proposed shape: the vocabulary-description and SHACL types (rdfs:Class, owl:Class, …) and SKOS (value sets). */
const NOT_SHAPED = [NS.rdf, NS.rdfs, NS.owl, NS.sh, NS.skos, NS.view, NS.ws];
export const shapeable = (c: string) => !NOT_SHAPED.some(ns => c.startsWith(ns));

/** IRIs that a node shape of the shapes graphs targets (sh:targetClass). */
export function shapedClasses(g: ModelGraph): Set<string> {
    return new Set(g.shapesQuads().filter(q => q.predicate.equals(S.targetClass) && q.object.termType === 'NamedNode').map(q => q.object.value));
}

/** The IRI types of the model graph that no node shape targets, sorted. `of`: the types of these subjects only. */
export function unshapedClasses(g: ModelGraph, of?: NamedNode[]): string[] {
    const shaped = shapedClasses(g);
    const quads = of ? of.flatMap(s => g.match(s, P.type, null, g.model)) : g.match(null, P.type, null, g.model);
    const classes = new Set(quads.filter(q => q.object.termType === 'NamedNode').map(q => q.object.value));
    return [...classes].filter(c => !shaped.has(c) && shapeable(c)).sort();
}

/**
 * Node shapes extracted from the model graph for `classes` (default: unshapedClasses), in the primary shapes file. A class that a
 * node shape targets already, or that shapeable() rejects, is skipped. Each shape gets sh:name, the label of its class. rdf:type gets no property shape (the target
 * class covers it). Returns the ids of the new node shapes.
 */
export function proposeShapes(g: ModelGraph, classes?: string[]): Result<string[]> {
    const graph = g.shapesTarget();
    if (!graph) return fail('The workspace has no shapes file. Use "Add Shapes…" first: new shapes go to the primary shapes file.');
    const shaped = shapedClasses(g);
    const targets = [...new Set(classes ?? unshapedClasses(g))].filter(c => !shaped.has(c) && shapeable(c));
    if (!targets.length) return fail(classes ? 'A node shape targets each of these classes already.' : 'Each class of the data has a node shape.');

    const data = g.modelTriples();
    const used = g.usedIris();
    for (const q of data) for (const t of [q.subject, q.object]) if (t.termType === 'NamedNode') used.add(t.value);
    const labels = new Map(targets.map(c => [c, g.label(rdf.namedNode(c))]));
    let extracted: Quad[];
    try {
        extracted = [...extractShapes(data, {
            graph: { type: 'default' },
            classes: targets,
            excludeProperties: [P.type.value],
            shapeIri: c => mintShapeIri(g, labels.get(c)!, used)
        })];
    } catch (e) {
        return fail(`The shapes could not be extracted: ${e instanceof Error ? e.message : String(e)}`);
    }
    const shapes = extracted.filter(q => q.predicate.equals(S.targetClass)).map(q => ({ shape: q.subject as NamedNode, cls: q.object.value }));
    const named = shapes.map(({ shape, cls }) => rdf.quad(shape, S.name, rdf.literal(labels.get(cls)!)));
    for (const q of skolemize([...extracted, ...named]).quads) g.add(q.subject, q.predicate, q.object, graph);
    return ok(shapes.map(s => elementId(s.shape)));
}
