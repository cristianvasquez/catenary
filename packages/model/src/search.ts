// Find Element (F8, Ctrl+T): the things of the store (packages/rdf/src/search.ts). The things are the typed subjects, the subjects with
// a label and no type, and the property shapes. The picker filters them by label, type and IRI.

import { NS } from './terms';

/** Kinds of the things, from their types (`searchKind`). */
export type SearchKind = 'instance' | 'view' | 'shape' | 'property' | 'valueSet';
export const SEARCH_KINDS: SearchKind[] = ['instance', 'view', 'shape', 'property', 'valueSet'];
export const SEARCH_KIND_NAMES: Record<SearchKind, string> = {
    instance: 'Instances', view: 'Views', shape: 'Node shapes', property: 'Property shapes', valueSet: 'Concept schemes and collections'
};

/** The kind of a thing from its types: the first known type in this order; no known type: an instance. */
const KIND_OF_TYPE: [string, SearchKind][] = [
    [NS.sh + 'PropertyShape', 'property'], [NS.sh + 'NodeShape', 'shape'], [NS.skos + 'ConceptScheme', 'valueSet'],
    [NS.skos + 'Collection', 'valueSet'], [NS.view + 'View', 'view']
];
export function searchKind(types: string[]): SearchKind {
    return KIND_OF_TYPE.find(([t]) => types.includes(t))?.[1] ?? 'instance';
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

/** The card that a view shows for a hit: the hit itself, or the node shape of a property shape. A view has no card. */
export function hitCard(h: SearchHit): string | undefined {
    if (h.kind === 'property') return h.owner;
    return h.kind === 'view' ? undefined : h.id;
}
