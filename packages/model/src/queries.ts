// The read queries of the model: one declaration for the store (@catenary/rdf implements it), the RPC service and the CLI.
// A new query: add it to ModelQueries and MODEL_QUERIES, then implement it in ModelStore. The compiler checks all three.

import type { ActionTarget, SelectionActions } from './actions';
import type { AppearanceData, GestureInfo, Occurrence, Showing, ViewGesture } from './view-ui';
import type { ExplorerDrag, ExplorerPath, ExplorerRow } from './explorer';
import type { OutlineNode } from './outline';
import type { SelectionLinks, View } from './doc';
import type { Choices, DeletePlan, ElementRow, LinkSection, NewLabelKind, RelationChoices } from './prompts';
import type { ModelSelection, Selected } from './selection';
import type { ShapesModel } from './shapes-doc';
import type { ElementProperties } from './properties';
import type { SearchFacets, SearchResult } from './search';
import type { Problem } from './validation';
import type { FileContent } from './snapshot';

export interface ModelQueries {
    /** Data graph of the SHACL form for an instance, as N-Triples. Empty if the instance does not exist. */
    formData(instanceId: string): string;
    /** Model explorer (ADR 0006): rows of a node key (none: the top folders); `currentView`: the view of the current view editor. */
    explorerChildren(key?: string, currentView?: string, file?: string, filter?: string): ExplorerRow[];
    /** Paths to the rows of an element in the Model explorer (Reveal). */
    explorerPaths(id: string): ExplorerPath[];
    /** Element ids of the rows under a node key of the Model explorer, at any depth. */
    explorerElements(key: string, file?: string): string[];
    explorerDrag(selection: ExplorerDrag): string[];
    /** Properties panel (ADR 0007): the data of an instance, relation, property shape or view; no id: the counts of the store. */
    properties(id?: string): ElementProperties | undefined;
    /** Outline of a view (ADR 0007): groups, cards and shown relations; nodes of `selection` (ids, the view of the selection) are selected. */
    outline(viewId: string, selection?: { view?: string; ids: string[] }): OutlineNode[];
    /** Problems panel (ADR 0007): the results of the SHACL report graph, with the labels of their instances. */
    problems(): Problem[];
    /** Search panel and Find Element: the things that match the facets, sorted by label, the first `limit`; the counts of the facet values. */
    search(facets: SearchFacets, limit: number): SearchResult;
    /** Labels of all views (view id → label): the titles of the view editors. */
    viewLabels(): Record<string, string>;
    /** A gesture of a view editor: why each candidate target is not one, and the facts of its element. */
    viewGesture(viewId: string, gesture: ViewGesture): GestureInfo;
    /** Appearance panel: the stored view, labels of the selected ids, selected relations, hidden edges. Undefined: no such view. */
    appearance(viewId: string, ids: string[]): AppearanceData | undefined;
    /** The views that show the selected element (one instance or relation) of a selection of `view` (F3, status bar). */
    occurrence(ids: string[], view?: string): Occurrence | undefined;
    /** The views that show an element, and the box of each (Show element). */
    showing(id: string): Showing;
    /** Links panel (ADR 0007): the selected elements (ids of the selection of `view`), their views and statements. */
    links(ids: string[], view?: string): SelectionLinks;
    /** Shapes as N-Triples (all graphs merged), for the SHACL form. Empty if no shapes are loaded. */
    shapesText(): string;
    /** Go to Source: every file with statements of an element, with the 1-based line of the element in each (the file on disk). */
    sources(id: string): Promise<{ path: string; line?: number }[]>;
    /** The actions that apply to a target and the facts to run them (spec/ui-manifest.hs §4, actions.ts). */
    selectionActions(target: ActionTarget): SelectionActions;
    /** The selection resolved: the ids that still exist, their elements, by kind (selection.ts). */
    selected(selection: ModelSelection): Selected;
    /** One stored view (from its view graph): boxes, edges and arrows with their placement ids. Undefined: no such view. */
    view(viewId: string): View | undefined;
    /** The shapes: node shapes, property shapes, logical constraints and value sets. */
    shapes(): ShapesModel;
    /** Delete from Model: the confirmation lines and notes for `ids` (prompts.ts). */
    deletePlan(ids: string[]): DeletePlan;
    /** Relation types that can link instance `source` to instance `target`, else why none can. Undefined: not two instances. */
    relationChoices(source: string, target: string): RelationChoices | undefined;
    /** Halo expand button: the instances related to `from` that the view does not show, with the relations to show. */
    neighborChoices(viewId: string, from: string, dir: 'out' | 'in'): Choices | undefined;
    /** Halo incoming button of a node shape card: the node shapes with a property to `from` that the view does not show. */
    shapeSourceChoices(viewId: string, from: string): Choices | undefined;
    /** Halo button of an instance card: node shapes with sh:targetSubjectsOf that applies to `from`, outside the view. */
    shapeTargetChoices(viewId: string, from: string): Choices | undefined;
    /**
     * Link button of an instance card: per relation type, the instances it can link to (placed in the view first, at most 50, `more`: the
     * others) and the new end it can create. `text`: only candidates whose label contains it.
     */
    linkChoices(dir: 'out' | 'in', from: string, viewId: string, text?: string): { title: string; sections: LinkSection[] } | { error: string } | undefined;
    /** Label of a new element: "unnamed <kind> N", the first free one (prompts.ts `newLabel`). */
    newLabel(kind: NewLabelKind, opts?: { classIri?: string; view?: string; base?: string }): string;
    /** Predicates in use (shapes, metamodel, data), and where each one is used. */
    knownPredicates(): { iri: string; where: string }[];
    /** Classes of the shapes and types of the instances: what a typed class name resolves to. */
    knownClasses(): { iri: string; name?: string }[];
    /** Labels of the instances that are not members of the collection `collection` of a view ("+ member"). */
    memberOptions(viewId: string, collection: string): string[];
    /** Ids of the instances with the label or IRI `text`. */
    instancesNamed(text: string): string[];
    /** Label and kind of each element (lists of several elements); `viewId`: the view of marks. Sorted by label. */
    elementRows(ids: string[], viewId?: string): ElementRow[];
    /** Of `ids`: the instances without a card and the relations without an edge in every view. */
    unplaced(ids: string[]): string[];
    /** What the file `path` holds that Catenary edits (workspace, views), from its content: how to open it. */
    fileContent(path: string): Promise<FileContent>;
}

/** The parameter names of each query (the RPC service and the CLI list them). The type requires one entry for each query. */
export const MODEL_QUERIES: { readonly [K in keyof ModelQueries]: readonly string[] } = {
    formData: ['instanceId'],
    explorerChildren: ['key', 'currentView', 'file', 'filter'],
    explorerPaths: ['id'],
    explorerElements: ['key', 'file'],
    explorerDrag: ['selection'],
    properties: ['id'],
    outline: ['viewId', 'selection'],
    problems: [],
    search: ['facets', 'limit'],
    viewLabels: [],
    viewGesture: ['viewId', 'gesture'],
    appearance: ['viewId', 'ids'],
    occurrence: ['ids', 'view'],
    showing: ['id'],
    links: ['ids', 'view'],
    shapesText: [],
    sources: ['id'],
    selectionActions: ['target'],
    selected: ['selection'],
    view: ['viewId'],
    shapes: [],
    deletePlan: ['ids'],
    relationChoices: ['source', 'target'],
    neighborChoices: ['viewId', 'from', 'dir'],
    shapeSourceChoices: ['viewId', 'from'],
    shapeTargetChoices: ['viewId', 'from'],
    linkChoices: ['dir', 'from', 'viewId', 'text'],
    newLabel: ['kind', 'opts'],
    knownPredicates: [],
    knownClasses: [],
    memberOptions: ['viewId', 'collection'],
    instancesNamed: ['text'],
    elementRows: ['ids', 'viewId'],
    unplaced: ['ids'],
    fileContent: ['path']
};

/** The interface of `T` over RPC: each method returns a promise. */
export type Remote<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };
