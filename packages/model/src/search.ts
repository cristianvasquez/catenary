// The Search panel and Find Element: a faceted search on the store (packages/rdf/src/search.ts). The things are the typed subjects,
// the subjects with a label and no type, the property shapes and the predicates in use. The facets are text, type and "linked to".

import { NS } from './terms';

/** Kinds of the things that the search finds, from their types (`searchKind`). */
export type SearchKind = 'instance' | 'view' | 'shape' | 'property' | 'valueSet' | 'predicate';
export const SEARCH_KINDS: SearchKind[] = ['instance', 'view', 'shape', 'property', 'valueSet', 'predicate'];
export const SEARCH_KIND_NAMES: Record<SearchKind, string> = {
    instance: 'Instances', view: 'Views', shape: 'Node shapes', property: 'Property shapes', valueSet: 'Concept schemes and collections',
    predicate: 'Predicates'
};

/** The kind of a thing from its types: the first known type in this order; no known type: an instance. */
const KIND_OF_TYPE: [string, SearchKind][] = [
    [NS.sh + 'PropertyShape', 'property'], [NS.sh + 'NodeShape', 'shape'], [NS.skos + 'ConceptScheme', 'valueSet'],
    [NS.skos + 'Collection', 'valueSet'], [NS.view + 'View', 'view'], [NS.rdf + 'Property', 'predicate']
];
export function searchKind(types: string[]): SearchKind {
    return KIND_OF_TYPE.find(([t]) => types.includes(t))?.[1] ?? 'instance';
}

/** The facets. Unset: no restriction. */
export interface SearchFacets {
    /** Each word is in the local name of the IRI or in a literal of the thing (case-insensitive). */
    text?: string;
    /** A type of the thing (rdfs:Resource: no type). */
    type?: string;
    /** Element id: a statement links the thing to it. `predicate` and `direction` ('out': `linkedTo` is the subject) narrow it. */
    linkedTo?: string;
    predicate?: string;
    direction?: 'out' | 'in';
}

export interface SearchHit {
    id: string;
    kind: SearchKind;
    label: string;
    /** The IRI of the thing. */
    iri: string;
    /** Its types (rdfs:Resource: none). */
    types: string[];
    /** A property shape: its node shape (the card that a view shows for it). */
    owner?: string;
    /** The views that show the thing. */
    views: string[];
}

/** A value of a facet and the number of things that it gives with the other facets. */
export interface FacetCount<T> { value: T; count: number }

/** The answer of the search: the first hits by label, the counts of the facet values, and the "linked to" element. */
export interface SearchResult {
    hits: SearchHit[];
    /** More things match than `hits` holds. */
    more: boolean;
    /** The types of the things that match the other facets. */
    types: FacetCount<string>[];
    /** The "linked to" element, and the relation types of its statements with the things that match the other facets. Undefined: no such element. */
    linked?: { id: string; label: string; iri: string; links: FacetCount<{ direction: 'out' | 'in'; predicate: string }>[] };
}
