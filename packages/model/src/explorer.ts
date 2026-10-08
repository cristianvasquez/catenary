// The rows of the Model explorer (ADR 0006). The backend gives the children of a node key by SPARQL; the frontend asks when a
// folder opens or refreshes.
//
// Node keys: 'class:<iri>', 'no-class', 'relations', 'rel:<predicate>', 'concepts', 'scheme:<iri>', 'no-scheme',
// 'collection:<iri>', 'concept:<iri>', 'shape:<node shape id>'. A leaf row of an element has its element id as key.

export type ExplorerKind = 'folder' | 'instance' | 'relation' | 'shape' | 'property' | 'view' | 'concept' | 'resource';

export interface ExplorerRow {
    /** Node key (see above). Unique among the children of one parent. */
    key: string;
    kind: ExplorerKind;
    name: string;
    /** The row has children (a query of its key). */
    folder: boolean;
    /** Element id: the selection of the row. */
    element?: string;
    /** View id of the graph of a view part (group, note, placement, …): the selection is in that view. */
    view?: string;
    /** Element id of the card that a drop on a view adds. */
    card?: string;
    /** Class folder: the class of the explicit New Instance action. */
    classIri?: string;
    badge?: string;
    /** Grey: an element with no placement in any view. */
    muted?: boolean;
    /** A placement in the current view. */
    inView?: boolean;
    problems?: number;
    /** JSON Canvas preset color (a class of the shapes). */
    color?: string;
    /** Codicon name. */
    icon?: string;
    description?: string;
    tooltip?: string;
}

/** A path to the row of an element: node keys from a top folder to the row key; `name`: the name of the top folder. */
export interface ExplorerPath { keys: string[]; name: string }

/** A drag describes all selected folders, not their currently visible children. */
export interface ExplorerDrag { file?: string; ids: string[]; folders: string[] }
export const EXPLORER_DRAG = 'application/x-catenary-explorer';

/** Key of the class folder of `iri`. */
export const classKey = (iri: string) => 'class:' + iri;
