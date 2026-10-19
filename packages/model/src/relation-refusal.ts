// The refusal of a relation that the metamodel does not permit: the facts that tell an agent what to change, and their message
// (spec/manifest.hs §6.2 law_refusalNamesShapes). ops.ts createRelation, commands.ts reconnectProblem and the read query canRelate use it.

import { iriId } from './ids';
import { Classes, RelationDef, classDef, outgoingRelations } from './metamodel';
import { ShapesModel, compactIri } from './shapes-doc';

/** A node shape that targets a class of the subject. */
export interface RefusalShape {
    id: string;
    label: string;
    targetClass: string;
}

export interface RelationRefusal {
    subject: { label: string; classes: string[] };
    object: { label: string; classes: string[] };
    predicate: string;
    /** The node shapes that target a class of the subject, in class order, once each. */
    shapes: RefusalShape[];
    /** The relation types that the metamodel permits from the classes of the subject. */
    permitted: RelationDef[];
}

/** The result of the read query canRelate (queries.ts). */
export type CanRelate =
    | { ok: true; permitted: RelationDef[] }
    | { ok: false; error: string; subjectClasses: string[]; objectClasses: string[]; predicate: string; shapes: RefusalShape[]; permitted: RelationDef[] };

/**
 * The facts of a refusal of the relation `predicate` from `subject` to `object`. The node shapes of a class: its ClassDef.shapes
 * (the SHACL plugin), with the label of the shapes model; a shape that is not in the model gives its compact IRI. Classes: sorted.
 */
export function relationRefusalData(meta: Classes, shapes: ShapesModel, subject: { label: string; classes: string[] },
    object: { label: string; classes: string[] }, predicate: string): RelationRefusal {
    // Sorted classes: the graph (ops.ts) and a Doc (commands.ts) give the same text.
    subject = { label: subject.label, classes: [...subject.classes].sort() };
    object = { label: object.label, classes: [...object.classes].sort() };
    const found: RefusalShape[] = [];
    for (const targetClass of subject.classes) {
        for (const iri of classDef(meta, targetClass)?.shapes ?? []) {
            const id = iriId(iri);
            if (!found.some(s => s.id === id)) found.push({ id, label: shapes.nodeShapes[id]?.label ?? compactIri(iri), targetClass });
        }
    }
    return { subject, object, predicate, shapes: found, permitted: outgoingRelations(meta, subject.classes) };
}

/** The message of a refusal: the predicate, both ends with their classes, the shapes of the subject and what they permit. */
export function relationRefusal(data: RelationRefusal): string {
    const classes = (c: string[]) => c.length ? c.map(compactIri).join(', ') : 'no class';
    const { subject: s, object: o } = data;
    const shapes = data.shapes.length ? data.shapes.map(x => `"${x.label}"`).join(', ') : 'none';
    const permitted = data.permitted.length ? data.permitted.map(r => `"${r.name}" (${compactIri(r.path)}) to ${compactIri(r.targetClass)}`).join(', ') : 'none';
    return `No shape or RDFS rule permits ${compactIri(data.predicate)} from "${s.label}" (${classes(s.classes)}) to "${o.label}" (${classes(o.classes)}).`
        + ` Shapes of the subject: ${shapes}.`
        + ` Permitted from "${s.label}": ${permitted}.`;
}

/** The canRelate result of a refusal. */
export function refusedRelation(error: string, data: RelationRefusal): CanRelate {
    return { ok: false, error, subjectClasses: data.subject.classes, objectClasses: data.object.classes, predicate: data.predicate, shapes: data.shapes, permitted: data.permitted };
}
