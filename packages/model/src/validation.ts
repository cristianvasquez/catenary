// A SHACL validation result, as JSON. Produced by @catenary/rdf.

export interface Violation {
    instance?: string;           // instance id, if the focus node is an instance
    focus: string;               // focus node IRI
    path?: string;               // predicate IRI (simple paths only)
    shape?: string;              // property shape id of the source shape, if it is one
    pathName?: string;
    severity: 'Violation' | 'Warning' | 'Info';
    component: string;           // local name of the constraint component
    message: string;
}

/** A row of the Problems panel (ADR 0007): a result of the SHACL report graph, with the label and class name of its focus node (an instance only). */
export interface Problem extends Violation {
    label?: string;
    className?: string;
}
