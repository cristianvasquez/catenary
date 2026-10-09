// The action model (spec/ui-manifest.hs §4). An action is an operation on the selection: one definition, the same
// on every surface. The selected elements and the data decide which actions apply, never the surface or the focus. The backend
// collects the facts of a selection from the store (packages/rdf/src/actions.ts, RPC `selectionActions`) and runs `applicableActions`;
// the frontend renders the answer in every menu and runs the action.

import { Doc, ElementKind, ViewCard, boxes, inside } from './doc';

/**
 * What an action acts on. `view`: the view of a selection made on a canvas (placements); none: a selection of elements (rows of
 * the Tree, Results, Links). `activeView`: the view of the current view editor, a parameter of "Add to view" only.
 */
export interface ActionTarget {
    view?: string;
    ids: string[];
    activeView?: string;
}

/** `none`: no selection needed (a surface adds it); `elements`: any selection; `view`: a selection made on a canvas only. */
export type ActionScope = 'none' | 'elements' | 'view';

/** Facts of a property shape. */
export interface PropertyFacts {
    /** Node shape id. */
    owner: string;
    /** Why the property is not a line on its own (`lineProblem`: a private end outside a logical constraint); undefined: it can be a line. */
    fixed?: string;
    /** In the view of the selection: an edge (taken out of its card). */
    takenOut?: boolean;
}

/** Facts of one selected item, from the store. */
export interface ItemFacts {
    /** The id as selected (a placement id on a canvas). */
    id: string;
    /** The element: a placement gives the element it places. */
    element: string;
    /** All kinds of the element: an IRI that is a node shape and an instance has both. Empty: an IRI the store does not know. */
    kinds: ElementKind[];
    /** rdf:type IRIs of the element, any graph. */
    types: string[];
    /** Placed on the view of the selection (`ActionTarget.view`). */
    placed: boolean;
    /** Placed on the active view (`ActionTarget.activeView`). */
    placedInActive: boolean;
    /** Number of views with a placement of the element. */
    views: number;
    /** Files with statements of the element (Open in → Source). */
    files: number;
    property?: PropertyFacts;
    /** The element is a class (a type of a resource, rdfs:Class, owl:Class or a target class): the node shapes that target it. */
    classShapes?: string[];
    /** Classes without a node shape that Propose Node Shapes from Data shapes: the element (a class), or its types in the data file. */
    unshaped: string[];
}

/**
 * A presentation that shows an element (Open in…): its file as Source at the position of the element, the Model pane of a file
 * with a row of it, or a Canvas that places it (`box`: its placement there). Lines and columns are 1-based (the file on disk).
 */
export type OpenTarget =
    | { presentation: 'Source'; path: string; line?: number; column?: number }
    | { presentation: 'Model'; path: string }
    | { presentation: 'Canvas'; view: string; label: string; box?: string };

export interface SelectionFacts {
    view?: string;
    activeView?: string;
    items: ItemFacts[];
}

/** One action for a selection. `enabled: false`: it applies to the elements but cannot run now; `reason` says why. */
export interface ActionState {
    id: string;
    enabled: boolean;
    reason?: string;
}

/** The answer of the backend for a selection: the actions that apply, and the facts the frontend needs to run them. */
export interface SelectionActions {
    actions: ActionState[];
    items: ItemFacts[];
    /** Cards that Show Details acts on (`displayCards`): a selection on a canvas only. */
    cards: ViewCard[];
}

/**
 * Applicability: false = the action does not apply (not shown); true = it applies; a string = it applies but cannot run now, the
 * string is the reason (shown disabled).
 */
export type Applies = boolean | string;

export interface ActionDef {
    id: string;
    label: string;
    /** Key shown in menus (the binding is registered by the frontend). */
    key?: string;
    scope: ActionScope;
    applies: (f: SelectionFacts) => Applies;
}

const has = (i: ItemFacts, ...kinds: ElementKind[]) => i.kinds.some(k => kinds.includes(k));
const one = (f: SelectionFacts) => f.items.length === 1 ? f.items[0] : undefined;
const all = (f: SelectionFacts, test: (i: ItemFacts) => boolean) => f.items.length > 0 && f.items.every(test);

/** Kinds with a label that Rename edits: in a dialog, in the Element section or in the name slot of a card. */
const NAMED: ElementKind[] = ['instance', 'view', 'shape', 'valueSet'];
/** Marks: elements of the Project layer that exist only through their placements. Their label or text is edited on the canvas. */
export const MARKS: ElementKind[] = ['group', 'note', 'reference', 'collection', 'arrow'];
/** Kinds that Delete from Model removes with their own statements. Marks: deleted with their placement. */
export const DELETABLE: ElementKind[] = ['instance', 'relation', 'view', 'shape', 'property', 'constraint', 'valueSet'];
/** Kinds that a view places as a card or an edge (Add to view). */
const PLACEABLE: ElementKind[] = ['instance', 'relation', 'shape', 'valueSet'];
/** Placements that Remove from View and Color act on. Property shapes are rows or edges of their card: not a placement of their own. */
export const VIEW_ITEMS: ElementKind[] = ['instance', 'relation', 'shape', 'valueSet', ...MARKS];

/** Property shapes and logical constraints of one node shape: the members of a new logical constraint. */
function groupable(f: SelectionFacts): Applies {
    const props = f.items.filter(i => i.property);
    const constraints = f.items.filter(i => has(i, 'constraint'));
    if (props.length + constraints.length !== f.items.length || f.items.length < 2 || constraints.length > 1) return false;
    if (new Set(props.map(i => i.property!.owner)).size > 1) return 'The properties are of different node shapes.';
    return true;
}

/** The actions, in menu order. Ids are the command ids of the frontend. */
export const ACTIONS: ActionDef[] = [
    // Open and navigate: one operation for every presentation, Source, Model and Canvas (spec/ui-manifest.hs §4.7).
    { id: 'catenary.openIn', label: 'Open in…', key: 'F12', scope: 'elements',
        applies: f => { const i = one(f); return !!i && (i.files > 0 || i.views > 0 || has(i, 'view') || 'No file and no view has the element.'); } },
    { id: 'catenary.nextOccurrence', label: 'Show in Next View', key: 'F3', scope: 'elements', applies: f => { const i = one(f); return !!i && i.views > 1; } },
    { id: 'catenary.previousOccurrence', label: 'Show in Previous View', key: 'Shift+F3', scope: 'elements', applies: f => { const i = one(f); return !!i && i.views > 1; } },
    // Edit
    { id: 'catenary.rename', label: 'Rename', key: 'F2', scope: 'elements',
        applies: f => { const i = one(f); return !!i && (has(i, ...NAMED) || (!!f.view && has(i, 'group', 'note'))); } },
    { id: 'catenary.editPath', label: 'Edit Path…', key: 'F2', scope: 'elements', applies: f => { const i = one(f); return !!i?.property && !has(i, ...NAMED); } },
    { id: 'catenary.editTarget', label: 'Change Target…', scope: 'elements', applies: f => !!one(f)?.property },
    { id: 'catenary.addAlternative', label: 'Add Target (One Of)…', scope: 'elements', applies: f => !!one(f)?.property },
    { id: 'catenary.groupOr', label: 'Group as "or"', scope: 'elements', applies: groupable },
    { id: 'catenary.groupXone', label: 'Group as "xone"', scope: 'elements', applies: f => !f.items.some(i => has(i, 'constraint')) && groupable(f) },
    { id: 'catenary.groupAnd', label: 'Group as "and"', scope: 'elements', applies: f => !f.items.some(i => has(i, 'constraint')) && groupable(f) },
    { id: 'catenary.ungroup', label: 'Ungroup Logical Constraint', scope: 'elements', applies: f => all(f, i => has(i, 'constraint')) },
    { id: 'catenary.duplicateView', label: 'Duplicate View', scope: 'elements', applies: f => { const i = one(f); return !!i && has(i, 'view'); } },
    { id: 'catenary.proposeShapes', label: 'Propose Node Shapes from Data', scope: 'elements',
        applies: f => {
            if (f.items.some(i => i.unshaped.length)) return true;
            const shapes = one(f)?.classShapes?.length;
            return !!shapes && `A node shape targets this class already (${shapes}).`;
        } },
    // Placements on the view of the selection
    { id: 'catenary.addToView', label: 'Add to Current View', scope: 'elements',
        applies: f => {
            const items = f.items.filter(i => has(i, ...PLACEABLE) && !has(i, 'view'));
            // Selected on the canvas of the active view: placed there already.
            if (!items.length || (f.view && f.view === f.activeView)) return false;
            if (!f.activeView) return 'No view editor is open.';
            return items.some(i => !i.placedInActive) || 'The current view places all of them.';
        } },
    { id: 'catenary.showAsEdge', label: 'Show as Edge', scope: 'view',
        applies: f => { const p = one(f)?.property; return !!p && !p.takenOut && !p.fixed; } },
    { id: 'catenary.showAsRow', label: 'Show as Row', scope: 'view', applies: f => f.items.some(i => !!i.property?.takenOut) },
    { id: 'catenary.collect', label: 'Collect into One Box', scope: 'view',
        applies: f => f.items.filter(i => i.placed && has(i, 'instance', 'collection')).length > 1 },
    { id: 'catenary.uncollect', label: 'Expand Collection', scope: 'view', applies: f => f.items.some(i => i.placed && has(i, 'collection')) },
    // Remove and delete (spec 0.4 Keys)
    { id: 'catenary.removeFromView', label: 'Remove from View', key: 'Del', scope: 'view', applies: f => f.items.some(i => i.placed && has(i, ...VIEW_ITEMS)) },
    { id: 'catenary.deleteFromModel', label: 'Delete from Model…', key: 'Ctrl+Del', scope: 'elements',
        applies: f => f.items.some(i => has(i, ...DELETABLE) || (!!f.view && i.placed && has(i, ...MARKS))) }
];

/** Color presets of the view elements: the same rule as Remove from View. Ids `catenary.color.<preset>`. */
export const colorApplies = (f: SelectionFacts): boolean => !!f.view && f.items.some(i => i.placed && has(i, ...VIEW_ITEMS));

/**
 * Cards that Show Details acts on: the selected instance and node-shape cards, and these cards inside the selected groups. `items`:
 * the facts of a selection on the canvas of `view`.
 */
export function displayCards(doc: Doc, view: string | undefined, items: ItemFacts[]): ViewCard[] {
    const v = view ? doc.views[view] : undefined;
    if (!v) return [];
    const placed = items.filter(i => i.placed);
    const groups = boxes(v, 'group').filter(g => placed.some(i => has(i, 'group') && i.element === g.id));
    return boxes(v, 'card').filter(c => (doc.instances[c.element] || doc.shapes.nodeShapes[c.element])
        && (placed.some(i => has(i, 'instance', 'shape') && i.element === c.element) || groups.some(g => inside(c, g))));
}

/** The actions that apply to a selection, in menu order. Scope `view` needs a selection made on a canvas. */
export function applicableActions(f: SelectionFacts): ActionState[] {
    const out: ActionState[] = [];
    for (const a of ACTIONS) {
        if (a.scope === 'view' && !f.view) continue;
        if (a.scope !== 'none' && !f.items.length) continue;
        const r = a.applies(f);
        if (r === false) continue;
        out.push(r === true ? { id: a.id, enabled: true } : { id: a.id, enabled: false, reason: r });
    }
    return out;
}

/** The items of a selection to act on, by kind: the element ids. */
export function itemsOfKind(items: ItemFacts[], ...kinds: ElementKind[]): string[] {
    return [...new Set(items.filter(i => has(i, ...kinds)).map(i => i.element))];
}

/** Key of a target: the same target gives the same key (cache of the answers). */
export function targetKey(t: ActionTarget): string {
    return JSON.stringify([t.view ?? '', t.activeView ?? '', [...t.ids].sort()]);
}
