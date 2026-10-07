// The selection of a window and the elements it holds, by kind. The backend resolves it (RPC `selected`, packages/rdf/src/selection.ts);
// the frontend keeps the selection ids only (ADR 0007).

/**
 * The selected items (never label ids), and the view they were selected in (if any). A selection on a canvas holds placements
 * (spec/ui-manifest.hs §3.3): a card and a placed edge by the id of their placement, as a mark. A listing selects elements.
 */
export interface ModelSelection {
    view?: string;
    ids: string[];
}

/** The elements of a selection that still exist, by kind. `view`: the view of the selection, if it still exists. */
export interface Selected {
    view?: string;
    /** The selected ids that still exist (placements stay placements). */
    ids: string[];
    /** The elements of these ids: a placement of a card or an edge gives its element; a mark stays. */
    elements: string[];
    instances: string[];
    relations: string[];
    views: string[];
    groups: string[];
    notes: string[];
    references: string[];
    collections: string[];
    arrows: string[];
    /** Shapes: node shapes, property shapes, logical constraints, value sets (SKOS concept schemes and collections). */
    shapes: string[];
    properties: string[];
    constraints: string[];
    valueSets: string[];
}

export function emptySelected(): Selected {
    return { ids: [], elements: [], instances: [], relations: [], views: [], groups: [], notes: [], references: [], collections: [], arrows: [],
        shapes: [], properties: [], constraints: [], valueSets: [] };
}

