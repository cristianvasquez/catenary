// Card rendering as plain snabbdom, without GLSP (views.ts wraps it).
// Sizes marked "screen" are divided by the zoom, so they stay constant on screen.

import { VNode, VNodeData, h } from 'snabbdom';
import type { AlternativeRow } from '@catenary/model';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG element: snabbdom `h` sets the namespace only for `svg` itself. */
export function s(tag: string, data: VNodeData, children: (VNode | string)[] = []): VNode {
    const node = h(tag, { ...data, ns: SVG_NS }, children.length === 1 && typeof children[0] === 'string' ? children[0] : children.filter((c): c is VNode => typeof c !== 'string'));
    return node;
}

// JSON Canvas preset colors "1".."6", "white" (stored as the CSS color name), and "none" (transparent: no fill, no border); any other
// value is a CSS color (for example #hex).
export const PRESETS: Record<string, string> = {
    'none': 'transparent', '1': '#d65a68', '2': '#d97a3a', '3': '#c5a13a', '4': '#4d9a70', '5': '#3e98a2', '6': '#7668c9', 'white': '#ffffff'
};
export const COLOR_NAMES: Record<string, string> = { 'none': 'none', '1': 'red', '2': 'orange', '3': 'yellow', '4': 'green', '5': 'cyan', '6': 'purple', 'white': 'white' };
/** The presets in menu order (object keys put "1".."6" before "none"). */
export const COLOR_ORDER = ['none', '1', '2', '3', '4', '5', '6', 'white'];
export const colorValue = (color?: string) => (color ? PRESETS[color] ?? color : undefined);
/** Style variables of an element with `color`. "none": the fills and borders mix with transparent, not with the background. */
export const colorVars = (color?: string): Record<string, string | undefined> =>
    color === 'none' ? { '--c': 'transparent', '--catenary-bg': 'transparent', '--catenary-border': 'transparent' } : { '--c': colorValue(color) };

export function vars(entries: Record<string, string | undefined>): Record<string, string> {
    const style: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) if (v) style[k] = v;
    return style;
}

/** Arrow path in a circle of radius 8 at 0,0. `in`: points left (back into the card), `out`: points right. */
export const ARROW_PATHS = { in: 'M4,0 L-4,0 M0,-4 L-4,0 L0,4', out: 'M-4,0 L4,0 M0,-4 L4,0 L0,4' };

/** Circled arrow in HTML (a card row): the same marks as the return arrow of an edge (edge-chrome.ts). */
export function arrowButton(dir: 'in' | 'out'): VNode {
    return h('svg', { class: { 'arrow-button': true }, attrs: { viewBox: '-9 -9 18 18' } }, [
        h('circle', { attrs: { r: 8, 'stroke-width': 1.5 } }),
        h('path', { attrs: { d: ARROW_PATHS[dir], 'stroke-width': 1.5 } })
    ]);
}

export interface CardProps {
    width: number;
    height: number;
    zoom: number;
    className: string;
    name: string;
    lines: string[];
    color: string;
    classColor: string;
    selected: boolean;
    hover: boolean;
    violations: number;
    known: boolean;
    display: string;
}

// Halo: the action buttons around the only selected element, docked as in Reactodia (widgets/halo.tsx). The resize
// handles (GLSP, see ResizeHandleView) sit on the box edge; the buttons sit outside them.

export type Dock = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
/** `column`: next button slot along the edge, from the corner inwards. `icon`: codicon name. `count`: a number at the button. */
export interface HaloAction { action: string; dock: Dock; column?: number; icon: string; title: string; count?: number }

const HALO_REMOVE: HaloAction = { action: 'remove', dock: 'ne', icon: 'close', title: 'Remove from view (Del)' };
const HALO_MENU: HaloAction = { action: 'menu', dock: 's', icon: 'ellipsis', title: 'More actions' };
/** The icon of every halo button that creates something (relation, property, arrow). */
const CREATE_ICON = 'add';
/**
 * Card. `link`: drag to a card (relation) or to empty canvas, or click (picker, with new instances). `linkIn`: the same, the card is
 * the object of the relation. `expandIn`, `expandOut`: related
 * instances that the view does not show (`hiddenNeighbors`), with their number; no button when there are none. Both arrows point
 * right: into the card on the left (incoming), out of it on the right (outgoing).
 */
export function cardHalo(incoming: number, outgoing: number, targets = 0): HaloAction[] {
    return [
        HALO_REMOVE, HALO_MENU,
        { action: 'reveal', dock: 'nw', icon: 'list-tree', title: 'Reveal in Model Explorer' },
        ...(incoming ? [{ action: 'expandIn', dock: 'w' as const, icon: 'arrow-right', title: `Incoming: show related instances (${incoming} not in the view)`, count: incoming }] : []),
        ...(outgoing ? [{ action: 'expandOut', dock: 'e' as const, icon: 'arrow-right', title: `Outgoing: show related instances (${outgoing} not in the view)`, count: outgoing }] : []),
        ...(targets ? [{ action: 'expandTargets', dock: 'n' as const, icon: 'schema', title: `Show applicable node shapes (${targets} not in the view)`, count: targets }] : []),
        { action: 'link', dock: 'se', icon: CREATE_ICON, title: 'New outgoing relation: drag to a card or to empty canvas, or click' }, 
        { action: 'linkIn', dock: 'sw', icon: CREATE_ICON, title: 'New incoming relation: drag to a card or to empty canvas, or click' }
    ];
}
/** Group, view reference. */
export const BOX_HALO: HaloAction[] = [HALO_REMOVE, HALO_MENU];
/** "One of" box: the element actions are on its property (row or line). Remove: the box and the line to it leave the view. */
export const ONE_OF_HALO: HaloAction[] = [HALO_REMOVE];
/** Note. `arrow`: drag to another element of the view (an arrow to it). */
export const NOTE_HALO: HaloAction[] = [HALO_REMOVE, HALO_MENU, { action: 'arrow', dock: 'se', icon: CREATE_ICON, title: 'Arrow: drag to an element of the view' }];
/** Collection: `uncollect` shows the cards of all members again (Reactodia: ungroup). */
export const COLLECTION_HALO: HaloAction[] = [
    { action: 'uncollect', dock: 'nw', icon: 'ungroup-by-ref-type', title: 'Expand: show the cards again' }, HALO_REMOVE, HALO_MENU
];
/** Several selected elements, around their common box (Reactodia: selection box). `collect` puts the cards into one collection. */
export const MULTI_HALO: HaloAction[] = [
    { action: 'collect', dock: 'nw', icon: 'group-by-ref-type', title: 'Collect the cards into one box' }, HALO_REMOVE, HALO_MENU
];

const BUTTON = 20;       // screen px, button size
const BUTTON_STEP = 22;  // screen px, button size + gap (next column)
const DOCK = 22;         // screen px from the box edge to the button center

/** Center of a halo button of a box at 0,0. */
export function dockCenter(width: number, height: number, dock: Dock, column: number, k: number): { x: number; y: number } {
    const d = DOCK * k, c = column * BUTTON_STEP * k;
    switch (dock) {
        case 'nw': return { x: -d + c, y: -d };
        case 'n': return { x: width / 2 + c, y: -d };
        case 'ne': return { x: width + d - c, y: -d };
        case 'e': return { x: width + d, y: height / 2 + c };
        case 'se': return { x: width + d - c, y: height + d };
        case 's': return { x: width / 2 + c, y: height + d };
        case 'sw': return { x: -d + c, y: height + d };
        case 'w': return { x: -d, y: height / 2 + c };
    }
}

/** Halo buttons of a box at 0,0: a transparent hit square and a codicon each. CanvasInteractions handles `data-action`. */
export function renderHalo(width: number, height: number, k: number, actions: HaloAction[]): VNode[] {
    const size = BUTTON * k;
    return actions.map(a => {
        const c = dockCenter(width, height, a.dock, a.column ?? 0, k);
        return s('g', { class: { 'halo-action': true }, attrs: { 'data-action': a.action } }, [
            s('title', {}, [a.title]),
            s('rect', { class: { hit: true }, attrs: { x: c.x - size / 2, y: c.y - size / 2, width: size, height: size, rx: 3 * k } }),
            s('foreignObject', { class: { 'halo-icon': true }, attrs: { x: c.x - size / 2, y: c.y - size / 2, width: size, height: size } }, [
                h('div', { style: { fontSize: `${16 * k}px` } }, [h('span', { class: { codicon: true, [`codicon-${a.icon}`]: true } })])
            ]),
            ...(a.count ? [s('text', { class: { 'halo-count': true }, attrs: { x: c.x, y: c.y + size / 2 + 8 * k }, style: { fontSize: `${12 * k}px` } }, [String(a.count)])] : [])
        ]);
    });
}

/** Point of a resize handle on a box at 0,0. */
export function handlePoint(width: number, height: number, location: string): { x: number; y: number } {
    const x = location.endsWith('left') ? 0 : location.endsWith('right') ? width : width / 2;
    const y = location.startsWith('top') ? 0 : location.startsWith('bottom') ? height : height / 2;
    return { x, y };
}

/** Resize handle as in Reactodia (utility/resizableBox.tsx): a circle at a corner, a bar at a side middle, in a larger hit area. */
export function resizeHandle(location: string, p: { x: number; y: number }, k: number, extra: VNodeData = {}): VNode {
    const corner = location.includes('-');
    const along = location === 'top' || location === 'bottom';
    const [w, hgt] = corner ? [0, 0] : along ? [26 * k, 9 * k] : [9 * k, 26 * k];
    const shape = corner
        ? [s('circle', { class: { hit: true }, attrs: { cx: p.x, cy: p.y, r: 12 * k } }),
            s('circle', { class: { mark: true }, attrs: { cx: p.x, cy: p.y, r: 6 * k, 'stroke-width': 2 * k } })]
        : [s('rect', { class: { hit: true }, attrs: { x: p.x - w / 2 - 3 * k, y: p.y - hgt / 2 - 3 * k, width: w + 6 * k, height: hgt + 6 * k } }),
            s('rect', { class: { mark: true }, attrs: { x: p.x - w / 2, y: p.y - hgt / 2, width: w, height: hgt, rx: 2 * k, 'stroke-width': 2 * k } })];
    return s('g', { ...extra, class: { 'catenary-resize-handle': true, ...(extra.class ?? {}) }, attrs: { ...(extra.attrs ?? {}), 'data-kind': location } }, shape);
}

/**
 * The card: body, content (class, name, field lines; the name wraps; `.card-name` is the rename slot of name-edit.ts), violation badge,
 * then the resize handles (`handles`, rendered by the caller). The halo is drawn above all elements (CatenaryGraphView).
 */
export function renderCard(p: CardProps, handles: VNode[]): VNode {
    const { width, height } = p;
    const simple = p.display === 'simple';
    const content = h('div', { class: { 'card-body': true, simple } }, [
        h('div', { class: { 'card-class': true } }, p.className),
        h('div', { class: { 'card-name': true } }, p.name),
        ...(simple ? [] : p.lines.map(l => h('div', { class: { 'card-line': true } }, l)))
    ]);
    const badge = p.violations > 0
        ? [s('g', { class: { badge: true } }, [
            s('circle', { attrs: { cx: width - 4, cy: 4, r: 16 } }),
            s('text', { attrs: { x: width - 4, y: 5 } }, [String(p.violations)])])]
        : [];
    return s('g', {
        class: {
            'catenary-card': true, colored: !!p.color, selected: p.selected, mouseover: p.hover, invalid: p.violations > 0, unknown: !p.known
        },
        style: vars({ ...colorVars(p.color), '--k': colorValue(p.classColor) })
    }, [
        s('rect', { class: { body: true }, attrs: { width, height, rx: 10 } }),
        s('foreignObject', { class: { 'card-fo': true }, attrs: { width, height } }, [content]),
        ...badge,
        ...handles
    ]);
}

export interface CollectionMember { id: string; label: string; className: string; classColor: string }
export interface CollectionProps extends MemberBoxProps { members: CollectionMember[] }

/**
 * One row of a member list. `key`: the member (instance id or concept IRI, `data-member`). `takeOut`: the instance id that ➟ shows as
 * a card; empty: ➟ is disabled with `takeOutTitle` as the reason.
 */
export interface MemberRow { key: string; label: string; sub: string; color: string; takeOut: string; takeOutTitle: string; removeTitle: string; title?: string }

/**
 * Member list of an instance collection and of a SKOS scheme or collection card: header, one row for each member (color, label,
 * second line, ➟: show as a card, ×: remove), then the add row. The box grows to show all rows (`memberListHeight`).
 */
export function renderMemberList(head: VNode[], rows: MemberRow[], add: string): VNode {
    return h('div', { class: { 'member-list': true } }, [
        ...head,
        ...rows.map(m => h('div', { class: { 'member-row': true }, style: vars({ '--k': colorValue(m.color) }), attrs: { 'data-member': m.key, ...(m.title ? { title: m.title } : {}) } }, [
            h('div', { class: { text: true } }, [h('div', { class: { 'member-label': true } }, m.label), h('div', { class: { 'member-sub': true } }, m.sub)]),
            h('span', {
                class: { 'member-take-out': true, disabled: !m.takeOut },
                attrs: { 'data-instance': m.takeOut, title: m.takeOutTitle }
            }, [arrowButton('out')]),
            h('span', { class: { 'member-remove': true, codicon: true, 'codicon-close': true }, attrs: { title: m.removeTitle } })
        ])),
        h('div', { class: { 'member-add': true } }, add)
    ]);
}

/** Box props shared by the member-list boxes (collection, value set, "one of"). */
export interface MemberBoxProps { width: number; height: number; color: string; selected: boolean; hover: boolean }

/**
 * A member-list box: an instance collection, a SKOS scheme or collection, the "one of" box of a property. One body, the member list
 * (renderMemberList) and the resize handles (`handles`, rendered by the caller). `kind`: the classes of the kind (colors, gestures).
 * A member with its own box in the view is a line from this box, not a row; a removal of that box gives the row back.
 */
export function renderMemberBox(kind: string[], p: MemberBoxProps, content: VNode, handles: VNode[]): VNode {
    return s('g', {
        class: { 'catenary-member-box': true, ...Object.fromEntries(kind.map(k => [k, true])), colored: !!p.color, selected: p.selected, mouseover: p.hover },
        style: vars(colorVars(p.color))
    }, [
        s('rect', { class: { body: true }, attrs: { width: p.width, height: p.height, rx: 10 } }),
        s('foreignObject', { class: { 'member-box-fo': true }, attrs: { width: p.width, height: p.height } }, [content]),
        ...handles
    ]);
}

/** Collection (Reactodia entity group): the member list of its cards. `handles`: the resize handles, rendered by the caller. */
export function renderCollection(p: CollectionProps, handles: VNode[]): VNode {
    const rows = p.members.map(m => ({
        key: m.id, label: m.label, sub: m.className, color: m.classColor, takeOut: m.id,
        takeOutTitle: 'Take out of the collection', removeTitle: 'Remove from the view'
    }));
    const content = renderMemberList([h('div', { class: { 'member-head': true } }, `Collection · ${p.members.length}`)], rows, '+ member');
    return renderMemberBox(['catenary-collection'], p, content, handles);
}

// ------------------------------------------------------------------ shapes views

/**
 * Node shape card. `link`: drag to another card or value set (a property to it) or to empty canvas (picker: datatype, value set, class, …).
 * `linkIn`: drag to another node shape (a property of it to this shape) or to empty canvas (picker: node shape, new node shape).
 */
/**
 * Node shape. `expandIn`: node shapes that the view does not show, with a property to this shape (`hiddenShapeSources`), with their
 * number; no button when there are none. The arrow points right, into the card, as on an instance card.
 */
export function shapeHalo(incoming: number, instances = 0): HaloAction[] {
    return [
        HALO_REMOVE, HALO_MENU,
        ...(instances ? [{ action: 'expandTargets', dock: 'n' as const, icon: 'list-tree', title: `Show checked instances (${instances} not in the view)`, count: instances }] : []),
        ...(incoming ? [{ action: 'expandIn', dock: 'w' as const, icon: 'arrow-right', title: `Incoming: show node shapes with a property to this shape (${incoming} not in the view)`, count: incoming }] : []),
        { action: 'link', dock: 'se', icon: CREATE_ICON, title: 'New property: drag to a node shape, a concept scheme or collection, or to empty canvas, or click' },
        { action: 'linkIn', dock: 'sw', icon: CREATE_ICON, title: 'New incoming property: drag to a node shape or to empty canvas, or click' }
    ];
}

export interface ShapeCardProps {
    width: number;
    height: number;
    className: string;
    name: string;
    subtitle: string;
    display: string;
    color: string;
    selected: boolean;
    hover: boolean;
    violations: number;
    closed: boolean;
}

/**
 * Node shape card: rounded box, class line, name and the target class, then the attribute rows (rendered by
 * the caller: HTML, one GLSP element each), "+ attribute", then the resize handles.
 */
export function renderShapeCard(p: ShapeCardProps, rows: VNode[], handles: VNode[]): VNode {
    const { width, height } = p;
    const simple = p.display === 'simple';
    const content = h('div', { class: { 'shape-body': true, simple } }, [
        h('div', { class: { 'shape-type': true } }, p.className),
        h('div', { class: { 'shape-name': true } }, p.name),
        ...(simple ? [] : [
            h('div', { class: { 'shape-class': true }, attrs: { title: `${p.subtitle}. Double-click edits the target class. Edit targets and node constraints in Properties.` } }, p.subtitle + (p.closed ? ' · closed' : '')),
            h('div', { class: { 'shape-rows': true } }, rows),
            h('div', { class: { 'shape-add-row': true }, attrs: { title: 'New attribute: type its path (prefix:local); Tab picks the value' } }, '+ attribute')
        ])
    ]);
    const badge = p.violations > 0
        ? [s('g', { class: { badge: true } }, [
            s('circle', { attrs: { cx: width - 4, cy: 4, r: 12 } }),
            s('text', { attrs: { x: width - 4, y: 5 } }, [String(p.violations)])])]
        : [];
    return s('g', {
        class: { 'catenary-card': true, 'shape-card': true, colored: !!p.color, selected: p.selected, mouseover: p.hover, invalid: p.violations > 0 },
        style: vars(colorVars(p.color))
    }, [
        s('rect', { class: { body: true }, attrs: { width, height, rx: 8 } }),
        s('foreignObject', { class: { 'card-fo': true }, attrs: { width, height } }, [content]),
        ...badge,
        ...handles
    ]);
}

export interface RowProps {
    parts: { text: string; color?: string }[];
    range: string;
    style: string;
    card: string;
    violations: number;
    selected: boolean;
    relation: boolean;
    /** A row group of an unplaced logical constraint (ADR 0014): 'head' (the operator, ⇥ places the hub), 'member' (a member row). */
    group?: string;
}

/**
 * A row of a shape card, as a member of a collection: path (prefix muted, local name colored; double-click edits it), value (click: pick
 * another), cardinality (`data-card`: click cycles it), and ⇥ (show as an edge; or drag the row out of the card).
 */
export function renderShapeRow(p: RowProps): VNode {
    if (p.group === 'head') return h('div', { class: { 'shape-row': true, 'row-group-head': true, selected: p.selected } }, [
        h('span', { class: { 'row-group-name': true }, attrs: { title: 'Logical constraint: its members follow' } }, p.parts.map(x => x.text).join('')),
        h('span', {}, ''), h('span', {}, ''),
        h('span', { class: { 'row-out': true }, attrs: { title: 'Show the constraint as a hub with its member lines' } }, [arrowButton('out')])
    ]);
    return h('div', { class: { 'shape-row': true, 'row-group-member': p.group === 'member', relation: p.relation, selected: p.selected, invalid: p.violations > 0 } }, [
        h('span', { class: { 'row-path': true }, attrs: { title: 'Path. Double-click or F2: edit' } }, p.parts.map(x => h('span', { style: x.color ? { color: x.color } : {}, class: { muted: !x.color } }, x.text))),
        h('span', { class: { 'row-range': true, [`leaf-${p.style}`]: true }, attrs: { title: 'Value. Click: change' } }, p.range),
        h('span', { class: { 'row-card': true }, attrs: { 'data-card': '1', title: 'Cardinality: click for the next one (0..* → 0..1 → 1 → 1..*)' } }, p.card),
        h('span', { class: { 'row-out': true }, attrs: { title: 'Show as an edge (or drag the row out of the card)' } }, [arrowButton('out')])
    ]);
}

export interface ValueSetProps extends MemberBoxProps {
    name: string;
    kind: 'scheme' | 'collection';
    uri: string;
    /** Concepts without a card in the view. `instance`: the id of the concept as an instance (data file), else empty. */
    members: { uri: string; label: string; broader?: string[]; instance: string }[];
}

/**
 * SKOS concept scheme or collection: name, kind and IRI, then the member list of its concepts (double-click: rename; ➟: show its
 * card; ×: remove; drag onto a concept: broader), "+ concept" / "+ member".
 */
export function renderValueSet(p: ValueSetProps, handles: VNode[]): VNode {
    const label = (uri: string) => p.members.find(c => c.uri === uri)?.label ?? uri;
    const rows = p.members.map(m => ({
        key: m.uri, label: m.label, sub: m.uri.replace(/^.*[#/:]/, ''), color: p.color, takeOut: m.instance,
        takeOutTitle: m.instance ? 'Show as a card' : 'The concept has no statements of its own: it cannot be a card',
        removeTitle: p.kind === 'scheme' ? 'Delete the concept' : 'Remove from the collection',
        title: `${m.uri}${m.broader?.length ? '\nBroader: ' + m.broader.map(label).join(', ') : ''}\nDouble-click: rename. Drag onto a concept: set broader.`
    }));
    const content = renderMemberList([
        h('div', { class: { 'vs-name': true } }, p.name),
        h('div', { class: { 'vs-kind': true } }, `${p.kind === 'scheme' ? 'concept scheme' : 'collection'} · ${p.members.length}`)
    ], rows, p.kind === 'scheme' ? '+ concept' : '+ member');
    return renderMemberBox(['catenary-card', 'valueset-card', `valueset-${p.kind}`], p, content, handles);
}

export interface OneOfProps extends MemberBoxProps {
    name: string;
    /** The alternatives without a line from this box. `key`: the range key of the alternative. */
    members: AlternativeRow[];
}

/**
 * "One of" box: the target of a property with an "or" range. Its rows are the alternatives without a line to their card (➟: show
 * the card of the alternative; ×: remove the alternative), then "+ target". The name is the target text (double-click: edit).
 */
export function renderOneOf(p: OneOfProps, handles: VNode[]): VNode {
    const rows = p.members.map(r => ({ key: r.key, label: r.label, sub: r.sub, color: '', takeOut: r.takeOut, takeOutTitle: r.takeOutTitle, removeTitle: 'Remove this target' }));
    const content = renderMemberList([
        h('div', { class: { 'vs-name': true } }, p.name),
        h('div', { class: { 'vs-kind': true } }, 'sh:or · each value is one of these targets')
    ], rows, '+ target');
    return renderMemberBox(['catenary-one-of'], p, content, handles);
}

/** Pill: the target of a property edge that is not a card (datatype, node kind, value set, scheme, a class or shape outside the view). */
export function renderPill(p: { width: number; height: number; text: string; style: string }): VNode {
    return s('g', { class: { 'catenary-leaf': true, [`leaf-${p.style}`]: true } }, [
        s('rect', { class: { body: true }, attrs: { width: p.width, height: p.height, rx: p.height / 2 } }),
        s('text', { attrs: { x: p.width / 2, y: p.height / 2 } }, [p.text])
    ]);
}
