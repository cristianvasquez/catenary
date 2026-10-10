// The schema provider contract. A vocabulary package (RDFS) reads its declarations through the query port and gives schema rules.
// The host merges the rules of all providers into the metamodel (@catenary/model mergeSchema). A rule says what a predicate takes
// on an instance of a class. It is a suggestion for the editor, not a constraint: validation does not use it.

import type { QueryPort } from '@catenary/query';

/**
 * What the objects of a predicate are: instances of a class (a relation), literals of a datatype (a field; no datatype: any literal),
 * or any value (a literal or a resource).
 */
export type SchemaRange = { kind: 'class'; iri: string } | { kind: 'literal'; datatype?: string } | { kind: 'any' };

export interface SchemaRule {
    /** The class of the subject. */
    domain: string;
    predicate: string;
    /** Written label of the predicate. None: the host names it from its IRI. */
    name?: string;
    description?: string;
    range: SchemaRange;
}

export interface Schema {
    rules: SchemaRule[];
    /** Written labels and descriptions of the classes of the rules. */
    classes: Record<string, { name?: string; description?: string }>;
}

export interface SchemaProvider {
    /** The source of the rules in the metamodel (`FieldDef.source`, `RelationDef.source`). */
    id: string;
    schema(port: QueryPort): Schema;
}
