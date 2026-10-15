// Find Element (F8, Ctrl+T): the things of the store (packages/rdf/src/search.ts). The things are the typed subjects, the subjects with
// a label and no type, and the property shapes. The picker filters them by label, type and IRI.

import { NS } from './terms';
import { iriId } from './ids';

/** Kinds of the things, from their types (`searchKind`). */
export type SearchKind = 'instance' | 'view' | 'shape' | 'property' | 'valueSet';
export const SEARCH_KINDS: SearchKind[] = ['instance', 'view', 'shape', 'property', 'valueSet'];
export const SEARCH_KIND_NAMES: Record<SearchKind, string> = {
    instance: 'Instances', view: 'Views', shape: 'Node shapes', property: 'Property shapes', valueSet: 'Concept schemes and collections'
};

/**
 * The kind of a thing from its types: the first known type in this order; no known type: an instance. A predicate (rdf:Property)
 * is not a thing: undefined. It has no card.
 */
const KIND_OF_TYPE: [string, SearchKind | undefined][] = [
    [NS.sh + 'PropertyShape', 'property'], [NS.sh + 'NodeShape', 'shape'], [NS.skos + 'ConceptScheme', 'valueSet'],
    [NS.skos + 'Collection', 'valueSet'], [NS.view + 'View', 'view'], [NS.rdf + 'Property', undefined]
];
export function searchKind(types: string[]): SearchKind | undefined {
    const known = KIND_OF_TYPE.find(([t]) => types.includes(t));
    return known ? known[1] : 'instance';
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

/** The filter of `search` (spec/manifest.hs §11.1). All keys are optional. */
export interface SearchFilter {
    /** Case-insensitive substring of the label, the IRI or a type. */
    text?: string;
    kind?: SearchKind;
    /** A class IRI in the types of the hit. */
    type?: string;
    /** A view id or view IRI that shows the hit. */
    view?: string;
    /** The maximum number of hits. */
    limit?: number;
    /** True: include the urn:skolem: subjects. Default: exclude them. */
    skolem?: boolean;
}
export const SEARCH_FILTER_KEYS: readonly (keyof SearchFilter)[] = ['text', 'kind', 'type', 'view', 'limit', 'skolem'];

const SKOLEM = 'urn:skolem:';

/** Check a filter from JSON: an object with known keys and values of the correct type. Else throw, with the valid keys. */
function checkFilter(filter: unknown): asserts filter is SearchFilter {
    const keys = SEARCH_FILTER_KEYS.join(', ');
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Error(`search: the filter must be a JSON object with the keys ${keys}`);
    const f = filter as Record<string, unknown>;
    const unknown = Object.keys(f).filter(k => !(SEARCH_FILTER_KEYS as readonly string[]).includes(k));
    if (unknown.length) throw new Error(`search: unknown filter key ${unknown.map(k => `"${k}"`).join(', ')}; valid keys: ${keys}`);
    for (const k of ['text', 'type', 'view'] as const) {
        if (f[k] !== undefined && typeof f[k] !== 'string') throw new Error(`search: "${k}" must be a string`);
    }
    if (f.kind !== undefined && !SEARCH_KINDS.includes(f.kind as SearchKind)) throw new Error(`search: "kind" must be one of ${SEARCH_KINDS.join(', ')}`);
    if (f.limit !== undefined && !(Number.isInteger(f.limit) && (f.limit as number) >= 0)) throw new Error('search: "limit" must be an integer >= 0');
    if (f.skolem !== undefined && typeof f.skolem !== 'boolean') throw new Error('search: "skolem" must be true or false');
}

/**
 * The hits that match all keys of `filter`, in their order (law_searchFilterSubset). Without `skolem: true`, no urn:skolem: subjects.
 * An unknown key or a wrong value throws, with the valid keys (law_searchUnknownKeyFails).
 */
export function filterHits(hits: SearchHit[], filter: SearchFilter): SearchHit[] {
    checkFilter(filter);
    const text = filter.text?.toLowerCase();
    const view = filter.view;
    const viewId = view === undefined ? undefined : iriId(view);
    const out = hits.filter(h => (filter.skolem || !h.iri.startsWith(SKOLEM))
        && (!text || [h.label, h.iri, ...h.types].some(s => s.toLowerCase().includes(text)))
        && (!filter.kind || h.kind === filter.kind)
        && (!filter.type || h.types.includes(filter.type))
        && (view === undefined || h.views.includes(view) || h.views.includes(viewId!)));
    return filter.limit === undefined ? out : out.slice(0, filter.limit);
}
