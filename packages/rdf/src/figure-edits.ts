// Placement edits with the notation engine (ADR 0014: removal, arrival, data arrival). Runs after each command, with placeConnectors (ops.ts):
//   removal       a removed placement takes the lines and hubs that need it, and each box kept by lines whose last line it took
//   arrival       a placed element brings the lines and hubs between it and the shown figures (not after Show as Line, a property edit)
//   data arrival  a new property shape is placed in each view that shows its start and its end
// Relations and arrows of instances: placeConnectors. The ids of the diagram: notation-schema.ts (@catenary/model).

import { LEAF_SUFFIX, NotationPlacement, Placements, Range, ViewFigures, arrival, dataArrival, iriId, nkey, removal, sha256Hex, unescapeId, viewFigures } from '@catenary/model';
import type { NamedNode, Term } from '@rdfjs/types';
import { ModelGraph, P, V } from './graph';
import { elementId } from './ids';
import * as ops from './ops';
import { readNotations, storeIndex } from './notations';
import { S, shapesIndexOf } from './shapes-read';
import { rdf } from './terms';

const SH = 'http://www.w3.org/ns/shacl#';

// --- list terms (rule 12) ---------------------------------------------------------------------------

const hash = (holder: string, predicate: string, n: number) => rdf.namedNode(`${ops.LIST_PREFIX}${sha256Hex(`${holder} ${predicate} ${n}`).slice(0, 12)}`);

/** The term of a list: `<holder> <predicate> <n>`, n the position of the list among the lists of that holder and predicate, by member text. */
export function listTermOf(g: ModelGraph, holder: NamedNode, predicate: NamedNode, head: Term): NamedNode {
    const text = (h: Term) => members(g, h).map(x => x.value).join(' ');
    const heads = g.match(holder, predicate).map(q => q.object).filter(h => g.match(h, RDF_FIRST).length > 0);
    const n = heads.sort((x, y) => text(x).localeCompare(text(y))).findIndex(h => h.equals(head)) + 1;
    return hash(holder.value, predicate.value, Math.max(1, n));
}

const RDF_FIRST = rdf.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#first'), RDF_REST = rdf.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#rest');

/** The members of an RDF list (any graph). */
function members(g: ModelGraph, head: Term): Term[] {
    const out: Term[] = [], seen = new Set<string>();
    for (let n: Term | undefined = head; n && !seen.has(n.value); n = g.match(n, RDF_REST)[0]?.object) {
        seen.add(n.value);
        const f = g.match(n, RDF_FIRST)[0]?.object;
        if (f) out.push(f);
    }
    return out;
}

/** The list term of a logical constraint id `c-<operator>-<shape>-<n>`. sh:not has no list (a «not» row): undefined. */
export function constraintTerm(cid: string): NamedNode | undefined {
    const m = /^c-(xone|or|and)-([A-Za-z0-9_]+)-(\d+)$/.exec(cid);
    const shape = m && unescapeId(m[2]);
    return shape ? hash(shape, SH + m[1], Number(m[3])) : undefined;
}

/** The list term of the "in" or "one of" box of a property shape (its sh:in or sh:or list). */
function rangeListTerm(g: ModelGraph, property: NamedNode): NamedNode | undefined {
    for (const p of [S.in, S.or]) {
        const head = g.match(property, p)[0]?.object;
        if (head) return listTermOf(g, property, p, head);
    }
    return undefined;
}

const PRIVATE: Range['kind'][] = ['datatype', 'nodeKind', 'any'];
const LIST_PREDICATES = [S.xone, S.or, S.and, S.in, RDF_FIRST, RDF_REST];

/**
 * The term that a diagram id stands for, for a removal or a move: a hub (a logical constraint id, a member line, the private pill of a
 * member), the list box of a property (`<property element id>_leaf`), else the element of the id. Undefined: nothing to place (a private pill
 * outside a hub).
 */
export function figureTermOf(g: ModelGraph, id: string): NamedNode | undefined {
    const shapes = shapesIndexOf(g).model;
    if (id.startsWith('c-')) return constraintTerm(id);
    const leaf = id.endsWith(LEAF_SUFFIX) ? id.slice(0, -LEAF_SUFFIX.length) : undefined;
    const p = shapes.properties[leaf ?? id] ?? Object.values(shapes.properties).find(x => x.uri && iriId(x.uri) === (leaf ?? id));
    if (p?.constraint) return constraintTerm(p.constraint);
    if (leaf !== undefined) {
        if (!p?.uri) return undefined;
        return PRIVATE.includes(p.range.kind) ? undefined : rangeListTerm(g, rdf.namedNode(p.uri));
    }
    return ops.cardTerm(g, id);
}

/**
 * Rule 12 places a list by the position n of the list among the lists of its holder and predicate (by member text). A command that
 * adds or removes a list of a holder can change the n of the other lists: their placements move to their new terms, in every view.
 * A placement of a removed list goes.
 */
function rekeyLists(g: ModelGraph): void {
    const removedQuads = g.changes().filter(c => c.op === 'remove').map(c => c.quad);
    const touched = new Map<string, { holder: NamedNode; predicate: NamedNode; added: Set<string>; removed: Set<string> }>();
    for (const { op, quad: q } of g.changes()) {
        if (!g.isShapesGraph(q.graph) || ![S.xone, S.or, S.and, S.in].some(p => q.predicate.equals(p)) || q.subject.termType !== 'NamedNode') continue;
        const k = `${q.subject.value} ${q.predicate.value}`;
        const t = touched.get(k) ?? touched.set(k, { holder: q.subject, predicate: q.predicate as NamedNode, added: new Set(), removed: new Set() }).get(k)!;
        (op === 'add' ? t.added : t.removed).add(q.object.value);
    }
    if (!touched.size) return;
    // The members of a removed list: from the removed quads.
    const removedMembers = (head: string): string[] => {
        const out: string[] = [], seen = new Set<string>();
        for (let n: string | undefined = head; n && !seen.has(n); n = removedQuads.find(q => q.subject.value === n && q.predicate.equals(RDF_REST))?.object.value) {
            seen.add(n);
            const f = removedQuads.find(q => q.subject.value === n && q.predicate.equals(RDF_FIRST))?.object.value;
            if (f) out.push(f);
        }
        return out;
    };
    const moves: { from: NamedNode; to?: NamedNode }[] = [];
    for (const { holder, predicate, added, removed } of touched.values()) {
        const now = g.match(holder, predicate).map(q => q.object).filter(h => g.match(h, RDF_FIRST).length > 0).map(h => ({ head: h.value, text: members(g, h).map(x => x.value).join(' ') }));
        const before = [...now.filter(h => !added.has(h.head)), ...[...removed].filter(h => !now.some(x => x.head === h)).map(h => ({ head: h, text: removedMembers(h).join(' ') }))]
            .filter(h => h.text);
        const position = (list: { head: string; text: string }[], head: string) => [...list].sort((x, y) => x.text.localeCompare(y.text)).findIndex(h => h.head === head) + 1;
        for (const h of before) {
            const from = hash(holder.value, predicate.value, position(before, h.head));
            const stays = now.some(x => x.head === h.head);
            const to = stays ? hash(holder.value, predicate.value, position(now, h.head)) : undefined;
            if (!to || !to.equals(from)) moves.push({ from, to });
        }
    }
    if (!moves.length) return;
    for (const view of g.views()) {
        // Take all old placements first: two lists can swap their terms.
        const taken = moves.map(m => ({ m, node: g.nodeOf(view, m.from) })).filter(x => x.node).map(({ m, node }) => {
            const props = g.match(node!, null, null, view).filter(q => !q.predicate.equals(V.element) && !q.predicate.equals(P.type) && !q.predicate.equals(V.view));
            ops.removeTree(g, node!, view);
            return { m, props };
        });
        for (const { m, props } of taken) {
            if (!m.to || g.nodeOf(view, m.to)) continue;
            const node = ops.addPlacement(g, view, m.to);
            for (const q of props) g.add(node, q.predicate, q.object, view);
        }
    }
}

// --- the post-step ----------------------------------------------------------------------------------

const key = (t: Term): string => t.termType === 'Quad'
    ? `<<(${key(t.subject)} ${key(t.predicate)} ${key(t.object)})>>`
    : t.termType === 'NamedNode' ? `<${t.value}>` : JSON.stringify([t.value]);

/** The term of a placed key: an IRI (a line, a hub, a box); statements are placed by placeConnectors. */
const iriOfKey = (k: string) => /^<([^<>]*)>$/.exec(k)?.[1];

/**
 * After a command: the removal and arrival rules for the placements that it changed, and data arrival for the property shapes that it
 * created. `arrivals` false: the command placed a target from a property (Show as Line, a property edit): no arrival.
 */
export function syncFigures(g: ModelGraph, arrivals: boolean): void {
    // A placement whose element changes (a new IRI) is not an arrival and not a removal: pair by placement subject.
    const placed = { add: new Map<string, { view: NamedNode; element: Term }>(), remove: new Map<string, { view: NamedNode; element: Term }>() };
    // A new IRI of a property shape, or a path edit, removes a sh:path: pair by subject and by path.
    const paths = { add: [] as { s: string; path: string }[], remove: [] as { s: string; path: string }[] };
    // A changed list of a logical constraint, "in" or "one of": its hub or box can be new or gone.
    let lists = false;
    for (const { op, quad: q } of g.changes()) {
        if ((q.predicate.equals(V.element) || q.predicate.equals(P.reifies)) && q.graph.termType === 'NamedNode')
            placed[op].set(q.graph.value + ' ' + q.subject.value, { view: q.graph, element: q.object });
        else if (q.predicate.equals(S.path) && g.isShapesGraph(q.graph)) paths[op].push({ s: q.subject.value, path: key(q.object) });
        if (g.isShapesGraph(q.graph) && LIST_PREDICATES.some(p => q.predicate.equals(p))) lists = true;
    }
    const byView = (op: 'add' | 'remove') => {
        const other = placed[op === 'add' ? 'remove' : 'add'], out = new Map<string, { view: NamedNode; keys: string[] }>();
        for (const [k, { view, element }] of placed[op]) {
            if (other.has(k)) continue;
            const v = out.get(view.value) ?? out.set(view.value, { view, keys: [] }).get(view.value)!;
            v.keys.push(key(element));
        }
        return out;
    };
    const added = byView('add'), removed = byView('remove');
    const created = new Set(paths.add.filter(a => !paths.remove.some(r => r.s === a.s || r.path === a.path)).map(a => `<${a.s}>`));
    if (!added.size && !removed.size && !created.size && !lists) return;
    if (lists) rekeyLists(g);

    const D = storeIndex(g), notes = readNotations();
    const views = created.size || lists ? g.views() : [...new Set([...added.keys(), ...removed.keys()])].map(v => rdf.namedNode(v));
    for (const view of views) {
        const vf = viewFigures(D, notes, view.value);
        const gone = new Set<string>(), add = new Set<string>();
        // Removal: the state before the command is the state after it, with the removed placements.
        const left = removed.get(view.value)?.keys ?? [];
        if (left.length) {
            const before: Placements = new Map(vf.placed);
            for (const k of left) before.set(k, { iri: '', simple: false, keptByLines: false } as NotationPlacement);
            for (const k of left) for (const x of removal(vf.derivation.figures, before, termOf(k))) if (!left.includes(x) && vf.placed.has(x)) gone.add(x);
        }
        const now: Placements = new Map([...vf.placed].filter(([k]) => !gone.has(k)));
        if (arrivals) for (const k of added.get(view.value)?.keys ?? []) {
            if (!now.has(k)) continue;
            for (const x of arrival(vf.derivation.figures, now, termOf(k))) if (!now.has(x) && iriOfKey(x)) add.add(x);
        }
        if (created.size) for (const x of dataArrival(vf.derivation.figures, now, created)) if (iriOfKey(x)) add.add(x);
        if (lists) {
            const figures = new Set(vf.derivation.figures.map(f => nkey(f.placedAs)));
            // A list placement without a figure (an ungrouped constraint, a removed range list) goes.
            for (const k of now.keys()) if (k.startsWith(`<${ops.LIST_PREFIX}`) && !figures.has(k)) gone.add(k);
            // A new constraint over lines that the view places: its hub, and the members lose their own placements (rule 7).
            for (const h of vf.derivation.figures) {
                if (h.fs.kind !== 'Hub' || now.has(nkey(h.placedAs))) continue;
                const lines = h.memberFigs.filter(m => m.fs.kind === 'Line' && now.has(nkey(m.placedAs)));
                if (!lines.length) continue;
                add.add(nkey(h.placedAs));
                for (const m of lines) gone.add(nkey(m.placedAs));
            }
        }
        for (const k of gone) { const iri = iriOfKey(k); if (iri) ops.dropFromView(g, view, rdf.namedNode(iri)); else removeStatementPlacement(g, view, vf, k); }
        for (const k of add) if (!g.nodeOf(view, rdf.namedNode(iriOfKey(k)!))) ops.addPlacement(g, view, rdf.namedNode(iriOfKey(k)!));
    }
}

/** A key as an engine term: an IRI, or a statement (its key is enough for the engine functions). */
function termOf(k: string) {
    const iri = iriOfKey(k);
    if (iri) return { termType: 'NamedNode' as const, value: iri };
    const m = /^<<\(<([^<>]*)> <([^<>]*)> <([^<>]*)>\)>>$/.exec(k);
    return m ? { termType: 'Triple' as const, value: '' as const, subject: { termType: 'NamedNode' as const, value: m[1] }, predicate: { termType: 'NamedNode' as const, value: m[2] }, object: { termType: 'NamedNode' as const, value: m[3] } }
        : { termType: 'NamedNode' as const, value: k };
}

function removeStatementPlacement(g: ModelGraph, view: NamedNode, _vf: ViewFigures, k: string): void {
    const t = termOf(k);
    if (t.termType !== 'Triple') return;
    const e = g.edgeOf(view, rdf.namedNode(t.subject.value), rdf.namedNode(t.predicate.value), rdf.namedNode(t.object.value));
    if (e) ops.removeTree(g, e, view);
}

// --- Show as Line ------------------------------------------------------------------------------------

/**
 * Show a property shape as a line in a view (⇥ on a row, Show as Edge): the box of its end, if the view does not show it, at `at`,
 * with view:keptByLines (it leaves with its last line); then the line. A member of a logical constraint: its hub, with the boxes of the
 * member ends. A sh:not member: a line with the tag «not». A datatype, node-kind or open end is private: such a line shows only in a
 * hub, so the property stays a row.
 * `id`: a property shape id or a constraint id. Returns an error text, or undefined.
 */
export function showAsLine(g: ModelGraph, viewId: string, id: string, at: { x: number; y: number }): string | undefined {
    const view = ops.viewTerm(g, viewId);
    if (!view) return 'The view does not exist.';
    const shapes = shapesIndexOf(g).model;
    const constraint = id.startsWith('c-') ? shapes.constraints[id] : undefined;
    // A sh:not constraint has no hub: its only member is a line with the tag «not», as a property without a constraint.
    const notMember = constraint?.operator === 'not' ? shapes.properties[constraint.members[0] ?? ''] : undefined;
    const p = notMember ?? (constraint ? undefined : shapes.properties[id]);
    const cid = constraint?.id ?? p?.constraint;
    if (cid && !cid.startsWith('c-not-')) {
        const hub = constraintTerm(cid);
        if (!hub) return 'This logical constraint has no list.';
        let i = 0;
        for (const m of shapes.constraints[cid]?.members ?? []) {
            const mp = shapes.properties[m];
            if (mp && !PRIVATE.includes(mp.range.kind)) i += placeEnd(g, view, mp.uri!, mp.range, { x: at.x, y: at.y + i * 120 }) ? 1 : 0;
        }
        if (!g.nodeOf(view, hub)) ops.addPlacement(g, view, hub);
        return undefined;
    }
    if (!p?.uri) return 'This property shape has no IRI. Reload the shapes file: the editor replaces blank nodes by IRIs.';
    if (PRIVATE.includes(p.range.kind)) return 'A property with a datatype, a node kind or no range is a row. It shows as a line only as a member of a logical constraint.';
    placeEnd(g, view, p.uri, p.range, at);
    const line = rdf.namedNode(p.uri);
    if (!g.nodeOf(view, line)) ops.addPlacement(g, view, line);
    return undefined;
}

/** Place the end box of a property line when the view does not show it. Returns true when it placed a box. */
function placeEnd(g: ModelGraph, view: NamedNode, property: string, range: Range, at: { x: number; y: number }): boolean {
    const shapes = shapesIndexOf(g).model;
    let term: NamedNode | undefined;
    if (range.kind === 'in' || range.kind === 'or') term = rangeListTerm(g, rdf.namedNode(property));
    else if (range.kind === 'node') term = shapes.nodeShapes[range.shape] ? rdf.namedNode(shapes.nodeShapes[range.shape].uri) : undefined;
    else if (range.kind === 'class') {
        // Several node shapes of the class: one that the view shows, else the first by ID (as the engine, joinState).
        const candidates = Object.values(shapes.nodeShapes).filter(n => n.targetClass === range.class).sort((a, b) => a.id.localeCompare(b.id));
        const shape = candidates.find(n => g.nodeOf(view, rdf.namedNode(n.uri))) ?? candidates[0];
        term = rdf.namedNode(shape?.uri ?? range.class);
    } else if (range.kind === 'scheme') term = range.schemes[0] ? rdf.namedNode(range.schemes[0]) : undefined;
    else if (range.kind === 'collection') term = rdf.namedNode(range.collection);
    if (!term || g.nodeOf(view, term)) return false;
    const size = ops.cardTerm(g, elementId(term)) && !term.value.startsWith(ops.LIST_PREFIX) ? ops.cardSize(g, elementId(term)) : { width: 240, height: 120 };
    const node = ops.addPlacement(g, view, term);
    ops.writeBox(g, view, node, { ...at, ...size });
    g.add(node, V.keptByLines, rdf.literal('true', rdf.namedNode('http://www.w3.org/2001/XMLSchema#boolean')), view);
    return true;
}

