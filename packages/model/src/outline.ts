// The Outline of a view editor (ADR 0007 step 4): the backend gives the tree by SPARQL on the view graph; the frontend keeps
// the expansion state only.

export type OutlineKind = 'group' | 'card' | 'out' | 'in';

export interface OutlineNode {
    kind: OutlineKind;
    /** A group or a card: its box id. 'out', 'in': the relation id. */
    key: string;
    name: string;
    /** Diagram id: the selection on the canvas (a group or a card: its box; a relation: its placed edge). */
    element: string;
    /** The selection (given with the request) shows this node in the view. */
    selected: boolean;
    children: OutlineNode[];
}
