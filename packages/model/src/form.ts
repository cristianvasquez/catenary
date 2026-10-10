// Statements of one instance as the SHACL form sees them, and the edit command for a form change.
// Pure: no DOM, no I/O.

import type { EditCommand } from './commands';
import type { Instance } from './doc';
import { ClassDef, Classes, classDef } from './metamodel';
import { NS, QuadLike, TermJSON, termKey, termToJSON } from './terms';

const LABEL = NS.rdfs + 'label';

/** Predicate IRI -> object terms, for the predicates that the form edits. */
export type Description = Record<string, TermJSON[]>;

/** Predicates that the form edits for a class: direct paths of its shapes. rdf:type is never edited. */
export function formPredicates(cls: ClassDef): string[] {
    const ps = new Set([...cls.fields.map(f => f.path), ...cls.relations.map(r => r.path)]);
    if (cls.labelInShape) ps.add(LABEL);
    return [...ps].sort();
}

/** The node shapes of the schema-rule forms: IRIs of no file, in the form shapes only (rdf shapes.ts formShapes). */
export const SCHEMA_FORM_PREFIX = 'urn:catenary:schema-form:';

/** The form node shape of the rules of provider `source` (`rdfs`) on class `cls`. */
export function schemaFormShape(source: string, cls: string): string {
    return `${SCHEMA_FORM_PREFIX}${source}:${encodeURIComponent(cls)}`;
}

/** The fields and relations of a class from one schema provider, by provider in order of appearance. */
export function schemaParts(cls: ClassDef): Map<string, (ClassDef['fields'][number] | ClassDef['relations'][number])[]> {
    const out = new Map<string, (ClassDef['fields'][number] | ClassDef['relations'][number])[]>();
    for (const x of [...cls.fields, ...cls.relations]) if (x.source) out.set(x.source, [...out.get(x.source) ?? [], x]);
    return out;
}

/** The schema-rule forms of an instance with `types`: one for each class and provider, with the predicates that it edits. */
export function schemaForms(meta: Classes, types: string[]): { cls: ClassDef; source: string; shape: string; predicates: string[] }[] {
    return types.flatMap(t => {
        const cls = classDef(meta, t);
        return cls ? [...schemaParts(cls)].map(([source, parts]) => ({ cls, source, shape: schemaFormShape(source, cls.iri), predicates: [...new Set(parts.map(x => x.path))].sort() })) : [];
    });
}

/** The statements that the form produced for `subject`. Blank-node objects are dropped (the model cannot store them). */
export function describeQuads(quads: Iterable<QuadLike>, subject: string, predicates: string[]): Description {
    const d: Description = Object.fromEntries(predicates.map(p => [p, [] as TermJSON[]]));
    for (const q of quads) {
        if (q.subject.termType !== 'NamedNode' || q.subject.value !== subject || !(q.predicate.value in d)) continue;
        const t = termToJSON(q.object);
        if (t) d[q.predicate.value].push(t);
    }
    return d;
}

function valuesKey(values: TermJSON[]): string {
    return values.map(termKey).sort().join(' ');
}

/** Stable text of a description. Two descriptions with the same statements have the same key. */
export function descriptionKey(d: Description): string {
    return Object.keys(d).sort().map(p => `<${p}> ${valuesKey(d[p])}`).join('\n');
}

/** The command that changes `before` (the model) into `after` (the form): the changed predicates only. Undefined if nothing changed. */
export function descriptionCommand(inst: Instance, before: Description, after: Description): EditCommand | undefined {
    const values: Record<string, TermJSON[]> = {};
    for (const p of Object.keys(after)) {
        if (valuesKey(before[p] ?? []) === valuesKey(after[p])) continue;
        values[p] = p === LABEL ? after[p].map(t => (t.termType === 'Literal' ? { ...t, value: t.value.trim() } : t)) : after[p];
    }
    return Object.keys(values).length ? { kind: 'setStatements', id: inst.id, values } : undefined;
}
