// Edit commands: the only way to change the model. Each command is one undo step. @catenary/rdf executes them.
// Also the pure parts of copy and paste (clips refer to instances by IRI) and the label rule.

import { CardDisplay, DEFAULT_SIZE, Doc, EdgeLayout, Instance, Relation, Side, View, ViewBox, boxes, cardOf, findRelation, inside, placementOfId } from './doc';
import { Classes, RelationDef, permittedRelations, primaryClass } from './metamodel';
import type { LogicalOperator, MigrationChange, PathJSON, Range } from './shapes-doc';
import type { TermJSON } from './terms';

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

/** Edit commands. Each command is one undo step. */
export type EditCommand =
    | { kind: 'createInstance'; classIri: string; label: string; view?: string; at?: Point }
    /**
     * Label of an instance, view, node shape, value set or concept (id of its IRI: iriId): the label predicates that it has, else its default.
     * `targetClass`: a node shape also gets this target class (the creation follow-up names the shape and its class in one step).
     */
    | { kind: 'rename'; id: string; label: string; targetClass?: string }
    | { kind: 'setUri'; id: string; uri?: string }
    /** Replace the statements (instance, predicate, *) for the given predicates. IRIs of instances are relations. */
    | { kind: 'setStatements'; id: string; values: Record<string, TermJSON[]> }
    /**
     * Delete elements of any kind in one step: instances and relations (from the model and all views), views (with the references to
     * them), node shapes (with their property shapes and cards), property shapes, unused value sets; constraints are dissolved.
     */
    | { kind: 'delete'; ids: string[] }
    /** Cards added around `at`. They bring the lines, links and hubs between them and the shown figures (ADR 0014, arrival). */
    | { kind: 'addToView'; view: string; ids: string[]; at: Point }
    /** Relations dropped on a view: their ends not in the view are added around `at`, hidden edges show again. */
    | { kind: 'showRelations'; view: string; ids: string[]; at: Point }
    /**
     * A property shape (`id`, any owner of a shared property) becomes a line in a view: its placement, and the box of its end at `at`
     * when the view does not show it (with view:keptByLines). A constraint id, or a member of a constraint: its hub, with the boxes of
     * the member ends. A datatype, node-kind or open end is private: such a property stays a row (an error). ADR 0014.
     */
    | { kind: 'showAsEdge'; view: string; id: string; at: Point }
    /**
     * Del in a view: cards leave, edges hide, and view-owned elements are deleted. The model does not change. A property line leaves:
     * the property is a row again. A hub, a member line or its pill: the hub unit leaves. The lines that need what left go too, and each
     * box kept by lines whose last line left (ADR 0014, removal).
     */
    | { kind: 'removeFromView'; view: string; ids: string[] }
    /** Cut: the selected view elements leave the view. */
    | { kind: 'cutFromView'; view: string; ids: string[] }
    /** Move or resize cards and view-owned nodes. A moved group takes the elements inside it. */
    | { kind: 'setBounds'; view: string; bounds: ({ id: string } & Partial<Rect>)[] }
    /** Apply Layout: new boxes (as setBounds), then the sides of these edges are cleared (each end faces the other card). */
    | { kind: 'setLayout'; view: string; bounds: ({ id: string } & Partial<Rect>)[]; clearSides: string[] }
    | { kind: 'setEdgeLayout'; view: string; relation: string; patch: Partial<Omit<EdgeLayout, 'relation'>> }
    | { kind: 'hideEdges'; view: string; ids: string[]; hidden: boolean }
    /**
     * Change elements of a view (cards, relations, groups, notes, view references, collections, arrows): box, color ('' removes it),
     * display of cards, label of groups, text of notes. A field that an element does not have is ignored; a relation takes only
     * the color. `expectedText`: the command fails if a note has another text (another client changed it).
     */
    | { kind: 'setViewDescription'; view: string; text: string; expectedText?: string }
    | { kind: 'setViewElements'; view: string; ids: string[]; patch: ViewElementPatch; expectedText?: string }
    /** Relation between instance ids or new instances. With a view, an end not in it is placed at `at`. */
    | { kind: 'createRelation'; subject: string | NewInstance; predicate: string; object: string | NewInstance; view?: string; at?: Point; sides?: EdgeSides }
    /**
     * Move one end of a relation (source: subject, target: object) to the instance `to`. The predicate does not change, the
     * relation gets a new id. Edge layouts stay in the views that show both new ends. With `view` and `side`, the moved end
     * attaches to that side in that view. `to` equal to the current end changes only the side.
     */
    | { kind: 'reconnectRelation'; relation: string; end: 'source' | 'target'; to: string; view?: string; side?: Side }
    /**
     * New view. `file`: path of its view file (absolute, or relative to the workspace folder), a new TriG file inside the workspace
     * folder; any name. Else `folder`: absolute path of the folder of its view file, inside the workspace folder; default: `views/`.
     */
    | { kind: 'createView'; label: string; folder?: string; file?: string }
    // ---- shapes (the shapes graphs; see ShapesModel)
    /**
     * New node shape in the primary shapes file; with a view (a shapes view), its card is placed at `at`. Its IRI is minted from
     * `label` + " shape" (a label that ends with " shape" gets no second one).
     */
    | { kind: 'createNodeShape'; label: string; targetClass?: string; view?: string; at?: Point }
    /**
     * Node shapes proposed from the data (SHACLxtract) in the primary shapes file: one for each class (default: each type of the data
     * file that no node shape targets). A class with a node shape is skipped. Result: the ids of the new node shapes.
     */
    | { kind: 'proposeShapes'; classes?: string[] }
    | { kind: 'setNodeShape'; id: string; patch: NodeShapePatch }
    /**
     * New property shape of node shape `shape`. The result id is the property shape. With `view` and `at` (a shapes view) and `out`: the
     * property is an edge (taken out of its card); its target card, or its pill, at `at`.
     * `newTarget`: first create a node shape (no target class; range sh:node) or a value set with this label, at `at`; `range` is ignored.
     * `newOwner`: first create a node shape with this label, at `at`, the owner of the property; `shape` is ignored. With `view`, `at`
     * and `out`, an owner that the view does not show gets its card at `at` (incoming link of a node shape).
     */
    | { kind: 'createPropertyShape'; shape: string; path: PathJSON; range: Range; minCount?: number; maxCount?: number; name?: string; view?: string; at?: Point; out?: boolean; newTarget?: NewShapeTarget; newOwner?: string }
    /** Change a property shape. null removes a value. The result id is the property shape. `view`, `at`: a new target of an edge of this view, or a new value set target, gets its card at `at`. */
    | { kind: 'setPropertyShape'; id: string; patch: PropertyShapePatch; view?: string; at?: Point }
    /** Group edges of one node shape into a logical constraint, or add edges to the constraint in `ids`. Result: the constraint id. */
    | { kind: 'groupProperties'; ids: string[]; operator?: Exclude<LogicalOperator, 'not'> }
    | { kind: 'setConstraint'; id: string; operator: LogicalOperator }
    /** Dissolve a logical constraint: its members go back to sh:property. */
    | { kind: 'ungroup'; id: string }
    | { kind: 'takeOutOfConstraint'; id: string }
    /** New SKOS concept scheme or collection in the primary shapes file; with a shapes view, its node is placed at `at`. */
    | { kind: 'createValueSet'; valueSet: 'scheme' | 'collection'; label: string; view?: string; at?: Point }
    /** Move the SKOS concept schemes, concepts and collections of the shapes files to the data file. Result: the number of subjects. */
    /** A new concept `label` joins a value set (scheme: skos:inScheme; collection: skos:member), or an existing concept `uri`. Result: its IRI. */
    | { kind: 'addConcept'; set: string; label?: string; uri?: string }
    /** Add skos:broader between existing concepts. Reject self-links and hierarchy cycles. */
    | { kind: 'setConceptBroader'; uri: string; broader: string }
    /** A concept leaves a value set: from a scheme it is deleted; from a collection only the membership goes. */
    | { kind: 'removeConcept'; set: string; uri: string }
    /** Apply a data change of the patch queue. `id`: the queue entry, removed on success. */
    | { kind: 'migrateData'; migration: MigrationChange & { id?: string } }
    | { kind: 'duplicateView'; id: string }
    | { kind: 'createGroup'; view: string; label: string; around?: string[]; rect?: Rect }
    | { kind: 'createNote'; view: string; text: string; at: Point }
    | { kind: 'addViewReference'; view: string; target: string; at: Point }
    /** A link box to a file (absolute path; the store keeps it relative to the view file). */
    | { kind: 'addFileReference'; view: string; file: string; at: Point }
    /**
     * Arrow between two boxes of a view (element ids; a card: its instance id). One end must be a note. The result id is the arrow.
     * Removal: removeFromView. An arrow goes with its note or other end.
     */
    | { kind: 'createArrow'; view: string; from: string; to: string }
    /**
     * Collect cards (instance ids) of a view into one new collection, centered on their box. Selected collections join it with their
     * members. The result id is the collection.
     */
    | { kind: 'collect'; view: string; ids: string[] }
    /** Instances (ids) join collection `id` of a view; an instance outside the view is added to it. */
    | { kind: 'addToCollection'; view: string; id: string; ids: string[] }
    /** Take members (all without `ids`) out of a collection: their cards show again, next to it. An empty collection is deleted. */
    | { kind: 'uncollect'; view: string; id: string; ids?: string[] }
    /**
     * Add the clip to a view. `at`: new top-left corner of the clip; without it, the positions do not change.
     * A copy clip creates new instances; a cut clip adds the same instances.
     */
    | { kind: 'pasteIntoView'; view: string; clip: ViewClip; at?: Point };

/** Changes of one element of a view. '' removes the color; display 'detailed' removes the display value. */
export type ViewElementPatch = Partial<Rect> & { color?: string; display?: CardDisplay; label?: string; text?: string };

/** A new instance at an end of a new relation. `inScheme`: a SKOS concept of this scheme. */
export type NewInstance = { classIri: string; label: string; inScheme?: string };
/** A new end of a new property shape: a node shape or a SKOS value set with this label. */
export type NewShapeTarget = { kind: 'nodeShape' | 'scheme' | 'collection'; label: string };

/** Changes of a node shape. Its name: the rename command. */
export interface NodeShapePatch {
    /** '' removes the target class. */
    targetClass?: string;
    closed?: boolean;
    /** '' removes it. */
    description?: string;
}

/** Changes of a property shape. null removes a value; an absent key does not change it. */
export interface PropertyShapePatch {
    path?: PathJSON;
    range?: Range;
    minCount?: number | null;
    maxCount?: number | null;
    name?: string | null;
    description?: string | null;
    pattern?: string | null;
    minLength?: number | null;
    maxLength?: number | null;
    languageIn?: string[] | null;
}

/**
 * Layout copied from a view (Ctrl+C / Ctrl+X). Instances are referred to by IRI, not by session id, so that a clip
 * from another model can only refer to the same resources. Mode 'cut': a paste adds the instances with these IRIs.
 * Mode 'copy': a paste creates new instances from the ones with these IRIs (types, field values, relations between them).
 */
export interface ViewClip {
    format: typeof VIEW_CLIP_FORMAT;
    mode: ClipMode;
    /**
     * Cards, groups, notes and view references. `id` and `element` of a card: the IRI of its element; `target` of a view reference: the view IRI,
     * so a clip does not depend on session ids. Other boxes: the id in the source view (not used by a paste).
     */
    boxes: Exclude<ViewBox, { kind: 'collection' }>[];
    edges: (Omit<EdgeLayout, 'relation'> & { subject: string; predicate: string; object: string })[];
}
export const VIEW_CLIP_FORMAT = 'application/x-catenary-view-clip';
export type ClipMode = 'copy' | 'cut';

/** Result of a command. `id` is the id of a created element, if any; `ids` the ids of all of them (paste). */
/** `protected`: the command changes these protected files (absolute paths), so it is refused (manifest ws:protect). */
export type CommandResult = { ok: true; id?: string; ids?: string[] } | { ok: false; error: string; protected?: string[] };

/** The answer of an import: the path of the copy and the prefixes that it added to the workspace. */
export type ImportResult = { ok: true; file: string; prefixes: string[] } | { ok: false; error: string };

/** Sides of the edge in the view. */
export type EdgeSides = Pick<EdgeLayout, 'fromSide' | 'toSide'>;

const GAP = 60;

/** Top-left positions for `count` cards in a grid centered on `at`. */
export function gridPositions(count: number, at: Point): Point[] {
    const { width, height } = DEFAULT_SIZE;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const x0 = at.x - (cols * (width + GAP) - GAP) / 2, y0 = at.y - (rows * (height + GAP) - GAP) / 2;
    return Array.from({ length: count }, (_, i) => ({ x: x0 + (i % cols) * (width + GAP), y: y0 + Math.floor(i / cols) * (height + GAP) }));
}

/** Top-left corner of a default-size card centered on `at`. */
export function centered(at: Point): Point {
    return { x: at.x - DEFAULT_SIZE.width / 2, y: at.y - DEFAULT_SIZE.height / 2 };
}

/**
 * The elements that a selection takes: a group takes the elements fully inside it; a collection takes its members' cards.
 */
export function selection(view: View, ids: string[]): ViewBox[] {
    // `ids`: box ids (placements); a card also by the id of its element.
    const picked = boxes(view, 'group').filter(x => ids.includes(x.id));
    const taken = (b: ViewBox) => ids.includes(b.id) || (b.kind === 'card' && ids.includes(b.element)) || picked.some(x => x.id !== b.id && inside(b, x));
    const collections = boxes(view, 'collection').filter(taken);
    return view.boxes.filter(b => taken(b) || (b.kind === 'card' && collections.some(c => c.members.includes(b.element))));
}

/** Clip of the selected cards and groups of a view. Edge layouts come with the relations between the clipped cards. */
export function copyFromView(doc: Doc, viewId: string, ids: string[], mode: ClipMode = 'copy'): ViewClip | undefined {
    const view = doc.views[viewId];
    if (!view) return undefined;
    const uri = (id: string) => doc.instances[id]?.uri ?? doc.shapes.nodeShapes[id].uri;
    const sel = selection(view, ids);
    const clipped = sel.flatMap((b): ViewClip['boxes'] => {
        if (b.kind === 'card') return [{ ...b, id: uri(b.element), element: uri(b.element) }];
        // A file reference is not copied (its path is relative to its view file).
        if (b.kind === 'reference') return b.target && doc.views[b.target] ? [{ ...b, target: doc.views[b.target].uri }] : [];
        // An entity group gives its members as cards (a member has no placement, ADR 0014 C1), stacked from the corner of the group.
        if (b.kind === 'collection') return b.members.filter(m => doc.instances[m] && !cardOf(view, m)).map((m, i) => ({
            kind: 'card' as const, id: uri(m), element: uri(m), x: b.x + i * 40, y: b.y + i * 40, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height
        }));
        return [b];
    });
    if (clipped.length === 0) return undefined;
    const members = new Set(sel.flatMap(b => b.kind === 'card' ? [b.element] : b.kind === 'collection' ? b.members : []));
    const edges = view.edges.flatMap(({ relation, id: _placement, ...layout }) => {
        const r = doc.relations[relation];
        return r && members.has(r.subject) && members.has(r.object) ? [{ subject: uri(r.subject), predicate: r.predicate, object: uri(r.object), ...layout }] : [];
    });
    return { format: VIEW_CLIP_FORMAT, mode, boxes: clipped, edges };
}

export function isViewClip(x: unknown): x is ViewClip {
    const c = x as ViewClip;
    return !!c && c.format === VIEW_CLIP_FORMAT && (c.mode === 'copy' || c.mode === 'cut') && Array.isArray(c.boxes) && Array.isArray(c.edges);
}

/** Check a label for an instance or view. Labels are not identity: two elements can have the same label. */
export function labelProblem(label: string): string | undefined {
    if (label.length === 0) return 'The label is empty.';
    if (label !== label.trim()) return 'The label has spaces at the start or the end.';
    return undefined;
}

/** Relation types that the shapes permit from instance `s` to instance `t` and that do not exist yet; else why there are none. */
export function freeRelations(meta: Classes, doc: Doc, s: Instance, t: Instance): { types: RelationDef[] } | { error: string } {
    if (s.id === t.id) return { error: 'A relation from an element to itself is not supported.' };
    const permitted = permittedRelations(meta, s.types, t.types, t.uri);
    const types = permitted.filter(r => !findRelation(doc, s.id, r.path, t.id));
    if (types.length) return { types };
    if (permitted.length) return { error: `All permitted relations from "${s.label}" to "${t.label}" exist already.` };
    const name = (i: Instance) => primaryClass(meta, i.types)?.name ?? 'unknown class';
    const reverse = permittedRelations(meta, t.types, s.types, s.uri).map(r => `"${r.name}"`);
    return { error: `The shapes permit no relation from ${name(s)} to ${name(t)}.`
        + (reverse.length ? ` They permit ${reverse.join(', ')} from ${name(t)} to ${name(s)}: draw it the other way.` : '') };
}

/**
 * Why the `end` of relation `r` cannot move to instance `to`; undefined: it can. The same instance: only the side changes. The rules
 * of the store (ops.reconnectRelation): no relation to itself, a type that the shapes permit, no duplicate.
 */
export function reconnectProblem(meta: Classes, doc: Doc, r: Relation, end: 'source' | 'target', to: string): string | undefined {
    const s = end === 'source' ? to : r.subject, o = end === 'target' ? to : r.object;
    if (s === r.subject && o === r.object) return undefined;
    if (s === o) return 'A relation from an element to itself is not supported.';
    const si = doc.instances[s], oi = doc.instances[o];
    if (!si || !oi) return 'A relation connects two instances.';
    if (!permittedRelations(meta, si.types, oi.types, oi.uri).some(d => d.path === r.predicate)) return `The shapes do not permit this relation from "${si.label}" to "${oi.label}".`;
    if (findRelation(doc, s, r.predicate, o)) return 'This relation exists already.';
    return undefined;
}

/**
 * Why an arrow from `from` to `to` of `view` cannot be made; undefined: it can. Ends: element or box ids (a card: its instance or its
 * placement). The rules of the store (ops.createArrow).
 */
export function arrowProblem(view: View, from: string, to: string): string | undefined {
    const [a, b] = [from, to].map(id => placementOfId(view, id));   // ViewArrow ends are box ids
    if (a === b) return 'An arrow connects two different elements.';
    const isNote = (id: string) => view.boxes.some(x => x.id === id && x.kind === 'note');
    if (!isNote(a) && !isNote(b)) return 'An arrow starts or ends at a note.';
    if (view.arrows.some(x => x.from === a && x.to === b)) return 'This arrow exists already.';
    return undefined;
}

/** Label for a new element: "unnamed <kind> 1", "unnamed <kind> 2", ... The first one that no element in `taken` has. */
export function unnamedLabel(kind: string, taken: Iterable<{ label: string }>): string {
    const used = new Set([...taken].map(t => t.label));
    const base = `unnamed ${kind.toLowerCase()}`;
    for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/**
 * Label for a copy: the next label not in `used`. A trailing number counts up ("Agent 1" -> "Agent 2", "agent-01" -> "agent-02");
 * a label without one gets " 2", " 3", ...
 */
export function nextLabel(label: string, used: Set<string>): string {
    const m = /^(.*?)(\d+)$/.exec(label);
    const next = m
        ? (i: number) => m[1] + String(Number(m[2]) + i).padStart(m[2].length, '0')
        : (i: number) => `${label} ${i + 1}`;
    for (let i = 1; ; i++) if (!used.has(next(i))) return next(i);
}
