// The fields provider contract. A vocabulary plugin reads its declarations through the query port and gives the values that an
// instance of a class can have: the Properties form and the cards show them. The host merges the fields of all plugins into the
// metamodel (@catenary/model): for a class and a predicate, the first plugin that gives a field or a link wins. All values are JSON.

import type { QueryPort } from '@catenary/query';

/** A value of a closed list (sh:in). A literal without a datatype is an xsd:string (or an rdf:langString with a language). */
export interface FieldValue {
    termType: 'NamedNode' | 'Literal';
    value: string;
    datatype?: string;
    language?: string;
}

export interface FieldRule {
    /** The class of the subject. A field of rdfs:label: the form edits the label. */
    domain: string;
    predicate: string;
    /** Written label of the predicate. None: the host names it from its IRI. */
    name?: string;
    description?: string;
    /** The datatype of the literals. None: any literal (or any IRI with `iri`). */
    datatype?: string;
    /** The values are IRIs, not literals (sh:nodeKind sh:IRI). */
    iri?: boolean;
    /** The allowed values (sh:in). */
    in?: FieldValue[];
    minCount?: number;
    maxCount?: number;
    order?: number;
}

export interface FieldsProvider {
    /** The plugin (`shacl`, `rdfs`): the same id in all its providers. */
    id: string;
    fields(port: QueryPort): FieldRule[];
}
