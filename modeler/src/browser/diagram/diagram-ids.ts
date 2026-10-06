// Ids of what a view editor shows, from the diagram graph that it holds (ADR 0007 step 5): a card or a placed edge has the id of
// its placement and the id of its element (`element`, from the graph schema). The view editors translate placement ⇄ element with
// this table, not with the read model.

import { TYPES } from '@catenary/model';
import type { ModelSelection } from '../selection-model';

/** The diagram elements of one view editor by id, with the element that each card or edge places. */
export interface DiagramIds {
    /** The graph has an element with this id. */
    has(id: string): boolean;
    /** The element that a diagram id shows: a card or a placed edge its element. Other ids stay (a mark: its placement). */
    elementOf(id: string): string;
    /** The diagram id that shows an element: its card or edge. Other ids stay. */
    placementOf(element: string): string;
    /** The schema fields of a diagram element (GLSP copies them to the client model by name). */
    get(id: string): Record<string, unknown> | undefined;
}

export function diagramIds(elements: Iterable<{ id: string; element?: unknown }>): DiagramIds {
    const byId = new Map<string, Record<string, unknown>>();
    const elementOf = new Map<string, string>(), placementOf = new Map<string, string>();
    for (const e of elements) {
        byId.set(e.id, e as unknown as Record<string, unknown>);
        if (typeof e.element !== 'string' || !e.element) continue;
        elementOf.set(e.id, e.element);
        if (!placementOf.has(e.element)) placementOf.set(e.element, e.id);
    }
    return {
        has: id => byId.has(id),
        elementOf: id => elementOf.get(id) ?? id,
        placementOf: element => placementOf.get(element) ?? element,
        get: id => byId.get(id)
    };
}

/**
 * Diagram types that a selection selects only in its own view: the view-owned elements, and value set cards (as selectionInView,
 * whose filter has no case for the value set kind).
 */
const ONLY_HERE: readonly string[] = [TYPES.GROUP, TYPES.NOTE, TYPES.VIEW_REFERENCE, TYPES.COLLECTION, TYPES.ARROW, TYPES.BUNDLE, TYPES.VALUESET];

/**
 * The diagram ids of the part of a selection that a view editor shows: what its graph has of the selected items (selectionInView on
 * the graph). A selection made in this view: its ids, or the card or edge of a selected element. Made in another view (`other`: the
 * element of a placement of that view) or in a listing: the cards and edges of the selected elements, and the shape elements (rows,
 * property edges, constraints); not view-owned elements and not value set cards.
 */
export function selectionInDiagram(ids: DiagramIds, s: ModelSelection, viewId: string, other: (view: string, id: string) => string): string[] {
    const here = s.view === viewId;
    const elements = here || !s.view ? s.ids : s.ids.map(id => other(s.view!, id));
    const allowed = (id: string) => here || !ONLY_HERE.includes(String(ids.get(id)?.type));
    const shown = (id: string) => {
        if (ids.has(id) && (here || ids.elementOf(id) === id)) return allowed(id) ? id : undefined;
        const p = ids.placementOf(id);
        return p !== id && allowed(p) ? p : undefined;
    };
    return [...new Set(elements.map(shown).filter((id): id is string => id !== undefined && ids.has(id)))];
}
