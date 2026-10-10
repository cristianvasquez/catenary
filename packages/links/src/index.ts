// The links provider contract. A vocabulary plugin reads its declarations through the query port and gives the links that an
// instance of a class can have: the link picker offers them and the canvas checks a drawn or reconnected edge against them. The host
// merges the links of all plugins into the metamodel (@catenary/model): for a class and a predicate, the first plugin that gives a
// link or a field wins. All values are JSON.

import type { QueryPort } from '@catenary/query';

export interface LinkRule {
    /** The class of the subject. */
    domain: string;
    predicate: string;
    /** The class of the object. None: an instance of any class. */
    target?: string;
    /** Written label of the predicate. None: the host names it from its IRI. */
    name?: string;
    description?: string;
    minCount?: number;
    maxCount?: number;
    order?: number;
    /**
     * The object is a concept of a scheme or a member of a collection (`target` skos:Concept): its IRI and the allowed objects.
     * No `values`: the concepts of scheme `iri` (the host knows the SKOS vocabulary).
     */
    valueSet?: { iri: string; values?: string[] };
}

export interface LinksProvider {
    /** The plugin (`shacl`, `rdfs`): the same id in all its providers. */
    id: string;
    links(port: QueryPort): LinkRule[];
}
