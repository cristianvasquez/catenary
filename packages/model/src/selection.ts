// The selection of a window and the elements it holds, by kind. The backend resolves it (RPC `selected`, packages/rdf/src/selection.ts);
// the frontend keeps the selection ids only (ADR 0007).

/**
 * The one selection of a window (spec/ui-manifest.hs §3.3 law_oneSelectionPerWindow): the selected items (never label ids), and the
 * view of the canvas that made it (the origin). A selection on a canvas holds placements of the origin (law_canvasSelectsPlacements):
 * a card and a placed edge by the id of their placement, a mark by its id. The origin needs them: remove from view, cut, drag between
 * views. Their elements: `Selected.elements` (backend) or the diagram of the origin (frontend). A listing selects elements, without origin.
 */
export interface ModelSelection {
    /** The origin: the view of the canvas that made the selection. Absent for a listing selection. */
    view?: string;
    /** Placements of the origin (a canvas selection) or elements (a listing selection). */
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

