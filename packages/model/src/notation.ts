// The notation engine (ADR 0014; vocabulary: docs/notation/notation.ttl): figures of one view, from the triples of the workspace and the notations.
// Steps: 1. the cascade from nt:notations of the view. 2. the targets of each figure shape. 3. nt:when (conforms()). 4. each focus
// gets the first figure shape that keeps it. 5. the roles give title, tags, rows, ends, members and connectors.
// The join with the placements of the view (what is drawn), removal and arrival: notation-join.ts.
// One generic program: it has no code for a vocabulary. The diagram: notation-schema.ts. The edits: packages/rdf/src/figure-edits.ts.

import { NTerm, NQuad, NT, Path, RDF, SH, TripleIndex, TripleTerm, classesOf, conforms, evalPath, inversePath, iri, nkey, parseShaclPath, pathJSON, triple, uniq } from './notation-graph';
import { formatPath, shortIri } from './shapes-doc';
import { sha256Hex } from './sha256';
import { NS, TermJSON, localName } from './terms';

export type FigureKind = 'Box' | 'Line' | 'Hub';
export type Role = 'title' | 'tag' | 'text' | 'min' | 'max' | 'part' | 'link' | 'from' | 'to' | 'anchor' | 'covers' | 'styled';

/** A property shape of a figure shape: one role. */
export interface RoleShape {
    path: Path;
    role: Role;
    order: number;
    select?: NTerm[];
    when?: NTerm;
    unplaced?: NTerm;
    style?: NTerm;
    private: boolean;
    /** nt:value: a fixed value instead of the values of the path. */
    value?: NTerm;
    /** nt:linkEnd on a part: as the end of a link, an unplaced part resolves to the owner box. */
    linkEnd: boolean;
}

export interface FigureShape {
    node: TermJSON;
    kind: FigureKind;
    title?: NTerm;
    style?: NTerm;
    when?: NTerm;
    gather?: NTerm;
    unplaced?: NTerm;
    keptByLines: boolean;
    openEnd?: string;
    inline?: { open: string; separator: string; close: string };
    targets: { class: NTerm[]; subjectsOf: NTerm[]; objectsOf: NTerm[]; node: NTerm[] };
    props: RoleShape[];
}

export interface Connector {
    statement: TripleTerm;
    style?: NTerm;
    unplaced: 'AsRow' | 'Hidden';
    text: string;
    /** The model property shape that gathered this connector (nt:gatherWith). */
    gathered?: NTerm;
    start?: Figure;
    end?: Figure;
}

export interface Row {
    order: number;
    rank: number;
    text: string;
    part?: Figure;
    value?: NTerm;
    sub?: Row[];
    connector?: Connector;
    gathered?: NTerm;
}

export interface Figure {
    id: string;
    focus: TermJSON;
    /** The term that a placement names: the focus, or for a list figure its list term (rule 12). */
    placedAs: TermJSON;
    fs: FigureShape;
    title?: string;
    hasOwnTitle: boolean;
    tags: string[];
    mult: string;
    style?: NTerm;
    rows: Row[];
    connectors: Connector[];
    startValues: NTerm[];
    endValue?: NTerm;
    /** A private (nt:private) or open (nt:openEnd) end: a pill of this line only, beside its start. */
    endPrivate: boolean;
    members: NTerm[];
    covers?: string;
    starts: Figure[];
    /** The end in a view: the first of `ends` that the view places, else the first (joinState sets it). */
    end?: Figure;
    /** The candidate ends: the figures of the values of the first nt:to with values, by IRI (a class with several node shapes). */
    ends: Figure[];
    memberFigs: Figure[];
    /** The label of a Line. */
    text?: string;
    /** The boxes that stand for this figure as the end of a link while it has no placement (nt:linkEnd parts). */
    carriers: Figure[];
}

export interface Notations {
    index: TripleIndex;
}

/** The notation triples (built-in files of the app, read by @catenary/rdf). */
export function notations(quads: readonly NQuad[]): Notations {
    return { index: new TripleIndex(quads) };
}

// --- the text rule -------------------------------------------------------------------------------
//
// The texts of the current app (shapes-doc.ts). An element: rdfs:label, skos:prefLabel or sh:name, else its local name. A predicate,
// a datatype or another end without a figure: prefix:local, else the local name (shortIri). A path: formatPath.

const LABELS = [NS.rdfs + 'label', NS.skos + 'prefLabel', SH('name')];

export function label(D: TripleIndex, t: NTerm | undefined): string {
    if (!t) return '—';
    if (t.termType === 'Literal') return t.value;
    if (t.termType === 'Triple') return `${label(D, t.subject)} ${shortIri(t.predicate.value)} ${label(D, t.object)}`;
    for (const p of LABELS) { const l = D.one(t, p); if (l) return l.value; }
    return localName(t.value);
}

/** An end that has no figure (a private pill, a value without a figure): its label, else prefix:local. */
export function termLabel(D: TripleIndex, t: NTerm): string {
    if (t.termType !== 'NamedNode' || LABELS.some(p => D.one(t, p))) return label(D, t);
    return shortIri(t.value);
}

/** A path value (a value of sh:path): a predicate as prefix:local, a path node as SPARQL path text. */
function pathText(D: TripleIndex, t: NTerm): string {
    const structural = [RDF('first'), SH('inversePath'), SH('alternativePath'), SH('zeroOrMorePath'), SH('oneOrMorePath'), SH('zeroOrOnePath')];
    return structural.some(p => D.one(t, p)) ? formatPath(pathJSON(D, t), shortIri) : shortIri(t.value);
}

/** "[1]", "[0..1]", "[1..*]", "[0..*]" (cardinalityText of the app, in brackets). */
export function multiplicity(min?: string, max?: string): string {
    const lo = min ?? '0';
    return ` [${max === undefined ? `${lo}..*` : lo === max ? lo : `${lo}..${max}`}]`;
}

/** The parts of a list box as inline text, with "+N" after three (rangeText of the app). */
function inline(fs: FigureShape, labels: string[]): string {
    const inl = fs.inline!, shown = labels.slice(0, labels.length > 3 ? 2 : 3);
    const more = labels.length > shown.length ? `${inl.separator}+${labels.length - shown.length}` : '';
    return `${inl.open}${shown.join(inl.separator)}${more}${inl.close}`;
}

// --- figure shapes in cascade order ----------------------------------------------------------------

const ROLE_RANK: Partial<Record<Role, number>> = { text: 0, part: 1 };
const word = (t: NTerm | undefined) => t ? t.value.slice(t.value.lastIndexOf('#') + 1) : undefined;

/** The cascade of a view: its nt:notations, else nt:default of the notations. */
export function figureShapes(N: TripleIndex, D: TripleIndex, view: TermJSON): FigureShape[] {
    const own = D.list(D.one(view, NT('notations')));
    const cascade = own.length ? own : N.list(N.one(iri(NT('default')), NT('notations')));
    if (cascade.length === 0) throw new Error(`view ${view.value} has no nt:notations and there is no default`);
    return cascade.flatMap(notation => N.list(N.one(notation, NT('figures'))).map(f => {
        const sep = N.one(f, NT('inlineSeparator'));
        return {
            node: f as TermJSON,
            kind: word(N.one(f, NT('kind'))) as FigureKind,
            title: N.one(f, NT('title')), style: N.one(f, NT('style')), when: N.one(f, NT('when')),
            gather: N.one(f, NT('gatherWith')), unplaced: N.one(f, NT('unplaced')),
            keptByLines: N.one(f, NT('keptByLines'))?.value === 'true', openEnd: N.one(f, NT('openEnd'))?.value,
            inline: sep && { open: N.one(f, NT('inlineOpen'))?.value ?? '', separator: sep.value, close: N.one(f, NT('inlineClose'))?.value ?? '' },
            targets: {
                class: N.objects(f, SH('targetClass')), subjectsOf: N.objects(f, SH('targetSubjectsOf')),
                objectsOf: N.objects(f, SH('targetObjectsOf')), node: N.objects(f, SH('targetNode'))
            },
            props: N.objects(f, SH('property')).map(ps => {
                const path = N.one(ps, SH('path')), select = N.one(ps, NT('select'));
                return {
                    path: path ? parseShaclPath(N, path) : { p: RDF('value') }, role: word(N.one(ps, NT('role'))) as Role,
                    order: Number(N.one(ps, SH('order'))?.value ?? Infinity), select: select ? N.list(select) : undefined,
                    when: N.one(ps, NT('when')), unplaced: N.one(ps, NT('unplaced')), style: N.one(ps, NT('style')),
                    private: N.one(ps, NT('private'))?.value === 'true', value: N.one(ps, NT('value')), linkEnd: N.one(ps, NT('linkEnd'))?.value === 'true'
                };
            }).sort((a, b) => a.order - b.order)
        };
    }));
}

function targets(D: TripleIndex, fs: FigureShape): TermJSON[] {
    const instances = (c: NTerm) => uniq(evalPath(D, { star: { inv: { p: NS.rdfs + 'subClassOf' } } }, c).flatMap(k => D.subjects(RDF('type'), k)));
    return uniq<NTerm>([
        ...fs.targets.class.flatMap(instances),
        ...fs.targets.subjectsOf.flatMap(p => D.subjectsOfP(p.value)),
        ...fs.targets.objectsOf.flatMap(p => D.objectsOfP(p.value)),
        ...fs.targets.node
    ]).filter((t): t is TermJSON => t.termType === 'NamedNode');
}

// --- identity of a list figure (rule 12) -----------------------------------------------------------
//
// A list head is a skolem IRI, and a command that rewrites the list makes new cells. So a list figure is placed by a hash of the
// statement that holds the list: <holder> <predicate> <n>, where n is the position of the list among the lists of that holder and
// predicate, sorted by the text of their members. These are the inputs of the constraint id (packages/rdf/src/ids.ts constraintId:
// c-<operator>-<shape>-<n>), so the two ids map one to one.

export function listTerm(D: TripleIndex, head: TermJSON): TermJSON | undefined {
    const holder = listHolder(D, head);
    return holder && iri(`urn:trellis:list:${sha256Hex(`${holder.subject.value} ${holder.predicate} ${holder.n}`).slice(0, 12)}`);
}

/** The statement that holds a list, and the position n of the list (rule 12). Undefined: not a list head, or not one holder. */
export function listHolder(D: TripleIndex, head: TermJSON): { subject: TermJSON; predicate: string; n: number } | undefined {
    if (!D.one(head, RDF('first'))) return undefined;
    const holders = D.incoming(head).filter(([p]) => p !== RDF('rest') && !p.startsWith(NS.view)).flatMap(([p, ss]) => ss.map(s => [s, p] as const));
    if (holders.length !== 1) return undefined;
    const [s, p] = holders[0];
    const text = (h: NTerm) => D.list(h).map(x => x.value).join(' ');
    const n = D.objects(s, p).filter(h => D.one(h, RDF('first'))).sort((x, y) => text(x).localeCompare(text(y))).findIndex(h => nkey(h) === nkey(head)) + 1;
    return { subject: s, predicate: p, n };
}

// --- figures ---------------------------------------------------------------------------------------

export interface Derivation {
    figures: Figure[];
    warnings: string[];
    data: TripleIndex;
}

/** The figures of a view. `data`: the triples of the workspace (data, shapes, SKOS, all view files). */
/**
 * List term (nkey) -> its list head, kept by the caller between derivations of one store (rule 12). The list term is a hash of its
 * holder, so a placed list term finds its head here, checked, and only a miss reads all lists.
 */
export type ListHeads = Map<string, TermJSON>;

export function deriveFigures(data: TripleIndex, notes: Notations, viewIri: string, scope?: readonly NTerm[], listHeads: ListHeads = new Map()): Derivation {
    const D = data, N = notes.index, view = iri(viewIri), viewName = localName(viewIri);
    const shapes = figureShapes(N, D, view);
    const warnings: string[] = [];

    // Steps 2–4: targets, nt:when, the first figure shape wins. A failed condition is memoized per (condition, focus).
    const memo = new Map<string, boolean>();
    const holds = (when: NTerm | undefined, focus: NTerm) => {
        if (!when) return true;
        const k = `${nkey(when)} ${nkey(focus)}`;
        if (!memo.has(k)) memo.set(k, conforms(D, N, when, focus));
        return memo.get(k)!;
    };
    const newFigure = (focus: TermJSON, fs: FigureShape): Figure => ({
        id: '', focus, placedAs: listTerm(D, focus) ?? focus, fs, hasOwnTitle: false, tags: [], mult: '', rows: [], connectors: [],
        startValues: [], endPrivate: false, members: [], starts: [], ends: [], memberFigs: [], carriers: []
    });
    const found = new Map<string, Figure>();
    if (!scope) {
        for (const fs of shapes) for (const focus of targets(D, fs)) {
            const k = nkey(focus);
            if (!found.has(k) && holds(fs.when, focus)) found.set(k, newFigure(focus, fs));
        }
    } else scopedFigures(D, shapes, scope, holds, newFigure, found, listHeads);
    // One order for a scoped and a whole derivation: the cascade, then the focus.
    const rank = new Map(shapes.map((fs, i) => [fs, i]));
    const figOf = new Map<string, Figure>(), used = new Set<string>();
    for (const f of [...found.values()].sort((a, b) => rank.get(a.fs)! - rank.get(b.fs)! || cmpKey(nkey(a.focus), nkey(b.focus)))) {
        const local = localName(f.focus.value) || 'x';
        let id = `urn:fig:${viewName}/${local}`;
        for (let n = 2; used.has(id); n++) id = `urn:fig:${viewName}/${local}-${n}`;
        used.add(id);
        f.id = id;
        figOf.set(nkey(f.focus), f);
    }
    const fig = (t: NTerm | undefined) => t && figOf.get(nkey(t));
    const roleValues = (f: Figure, role: Role) => f.fs.props.filter(p => p.role === role && holds(p.when, f.focus))
        .map(p => ({ p, values: (p.value ? [p.value] : evalPath(D, p.path, f.focus)).filter(v => !p.select || p.select.some(s => nkey(s) === nkey(v))) }));
    const firstWith = (f: Figure, role: Role) => roleValues(f, role).find(r => r.values.length);
    const first = (f: Figure, role: Role) => firstWith(f, role)?.values[0];
    const hasRole = (f: Figure, role: Role) => f.fs.props.some(p => p.role === role);

    // Step 5a: title, tags, multiplicity, style, ends, members, covered predicate.
    for (const f of figOf.values()) {
        const t = f.fs.title;
        if (t?.value === NT('TargetPredicate')) {
            const p = f.fs.targets.objectsOf.find(p => D.subjects(p.value, f.focus).length);
            f.title = p ? localName(p.value) : undefined;
        } else if (t) f.title = t.value;
        else {
            const titleRole = firstWith(f, 'title');
            // A title that is a path (the value of sh:path) reads as a predicate, or as path text (formatPath).
            f.title = titleRole ? ('p' in titleRole.p.path && titleRole.p.path.p === SH('path') ? pathText(D, titleRole.values[0]) : label(D, titleRole.values[0])) : label(D, f.focus);
        }
        f.hasOwnTitle = Boolean(t || first(f, 'title'));
        f.tags = roleValues(f, 'tag').flatMap(r => r.values).map(v => `«${label(D, v)}»`);
        f.mult = hasRole(f, 'min') || hasRole(f, 'max') ? multiplicity(first(f, 'min')?.value, first(f, 'max')?.value) : '';
        f.style = first(f, 'styled') ?? f.fs.style;
        f.startValues = firstWith(f, 'from')?.values ?? [];
        f.endValue = first(f, 'to');
        f.endPrivate = Boolean(firstWith(f, 'to')?.p.private) || (f.fs.kind === 'Line' && !f.endValue && Boolean(f.fs.openEnd));
        f.members = roleValues(f, 'anchor').flatMap(r => r.values);
        const covers = f.fs.props.find(p => p.role === 'covers')?.path;
        f.covers = covers && 'p' in covers ? covers.p : undefined;
    }

    // Step 5b: parts (rows), text lines, links (connectors). Rows follow sh:order, then the role order.
    const owners = new Map<string, Figure[]>();
    for (const f of figOf.values()) {
        for (const { p, values } of roleValues(f, 'text')) for (const v of values)
            f.rows.push({ order: p.order, rank: ROLE_RANK.text!, text: `${shortIri('p' in p.path ? p.path.p : RDF('value'))}: ${label(D, v)}` });
        for (const { p, values } of roleValues(f, 'part')) for (const v of values) {
            const pf = fig(v);
            f.rows.push({ order: p.order, rank: ROLE_RANK.part!, text: '', part: pf, value: v });
            if (pf) (owners.get(pf.id) ?? owners.set(pf.id, []).get(pf.id)!).push(f);
            if (pf && p.linkEnd) pf.carriers.push(f);
        }
        f.rows.sort((a, b) => a.order - b.order || a.rank - b.rank);
        // A link path is a predicate (the focus is the subject) or an inverse predicate (the focus is the object).
        for (const { p, values } of roleValues(f, 'link')) {
            const pred = 'p' in p.path ? p.path.p : 'inv' in p.path && 'p' in p.path.inv ? p.path.inv.p : undefined;
            if (!pred) { warnings.push(`${f.id}: a link path must be a predicate or an inverse predicate`); continue; }
            for (const v of values) f.connectors.push({
                statement: 'p' in p.path ? triple(f.focus, pred, v) : triple(v, pred, f.focus), style: p.style,
                unplaced: unplacedOf(p.unplaced ?? f.fs.unplaced), text: `${shortIri(pred)}: ${label(D, v)}`
            });
        }
        if (f.fs.gather?.value === NT('ModelShapes'))
            gather(D, f, warnings, f.fs.props.filter(p => p.role === 'title' && 'p' in p.path).map(p => (p.path as { p: string }).p));
    }

    // Step 5c: ends. A Line starts at each value of its first nt:from with values (a shared property shape has several owners).
    // Without nt:from, it starts at each figure that has it as a part.
    for (const f of figOf.values()) {
        f.starts = f.startValues.length ? f.startValues.map(fig).filter((x): x is Figure => Boolean(x)) : f.fs.kind === 'Line' ? owners.get(f.id) ?? [] : [];
        f.ends = f.endPrivate ? [] : (firstWith(f, 'to')?.values ?? []).map(fig).filter((x): x is Figure => Boolean(x));
        f.end = f.ends[0];
        f.memberFigs = f.members.map(fig).filter((x): x is Figure => Boolean(x));
        for (const c of f.connectors) { c.start = fig(c.statement.subject); c.end = fig(c.statement.object); }
    }

    // Step 5d: row text (text rule). The end of a line reads as the title of its figure, or inline when it is a list box.
    const endText = (f: Figure): string | undefined => {
        if (!f.endValue) return f.fs.openEnd;
        const e = f.endPrivate ? undefined : fig(f.endValue);
        if (e?.fs.inline) return inline(e.fs, e.rows.filter(r => r.part || r.value).map(r => rowText(r.part, r.value)));
        return e?.title ?? termLabel(D, f.endValue);
    };
    const rowText = (pf: Figure | undefined, v: NTerm | undefined): string => {
        if (!pf) return v ? termLabel(D, v) : '—';
        const tags = pf.tags.length ? pf.tags.join(' ') + ' ' : '';
        if (pf.fs.kind === 'Line') {
            const end = endText(pf);
            return tags + (pf.hasOwnTitle ? `${pf.title}${end ? ': ' + end : ''}${pf.mult}` : `${end ?? pf.title}${pf.mult}`);
        }
        return tags + (pf.title ?? '');
    };
    for (const f of figOf.values()) for (const r of f.rows) if (!r.text) {
        r.text = rowText(r.part, r.value);
        if (r.part?.fs.kind === 'Hub') r.sub = r.part.members.map(m => ({ order: 0, rank: 0, part: fig(m), value: m, text: rowText(fig(m), m) }));
    }
    for (const f of figOf.values()) if (f.fs.kind === 'Line') f.text = `${(f.hasOwnTitle ? f.title : endText(f)) ?? ''}${f.mult}`.trim();
    return { figures: [...figOf.values()], warnings, data: D };
}

const cmpKey = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const LINKING: Role[] = ['part', 'from', 'to', 'anchor', 'link'];

/** A focus is a target of a figure shape: the membership test of `targets`, without the enumeration of the workspace. */
function isTarget(D: TripleIndex, fs: FigureShape, t: TermJSON): boolean {
    if (t.termType !== 'NamedNode') return false;
    if (fs.targets.node.some(n => nkey(n) === nkey(t))) return true;
    if (fs.targets.subjectsOf.some(p => D.objects(t, p.value).length)) return true;
    if (fs.targets.objectsOf.some(p => D.subjects(p.value, t).length)) return true;
    return fs.targets.class.length > 0 && classesOf(D, t).some(c => fs.targets.class.some(k => nkey(k) === nkey(c)));
}

/**
 * Steps 2–4 for the figures that the placement rules of a view can read, from its placed terms outwards: the placed figures, the
 * lines and hubs whose role paths reach a placed figure or one of these lines, their role values (parts, ends and members), and the
 * role values of those, no further (the ends of a line found so are kept too). A line or hub that reaches no placed figure is never shown, and no arrival or removal from these terms takes it
 * (law_scopedFiguresPreservePlacementRules). The data is read around these terms only.
 */
function scopedFigures(D: TripleIndex, shapes: FigureShape[], scope: readonly NTerm[], holds: (when: NTerm | undefined, focus: NTerm) => boolean,
    newFigure: (focus: TermJSON, fs: FigureShape) => Figure, figOf: Map<string, Figure>, listHeads: ListHeads): void {
    const decided = new Map<string, Figure | null>();
    const decide = (t: NTerm): Figure | undefined => {
        if (t.termType !== 'NamedNode') return undefined;
        const k = nkey(t);
        if (!decided.has(k)) {
            const fs = shapes.find(fs => isTarget(D, fs, t) && holds(fs.when, t));
            decided.set(k, fs ? newFigure(t, fs) : null);
        }
        return decided.get(k) ?? undefined;
    };
    // `depth`: 0 a placed figure or a line or hub that reaches one; n a role value n steps from one. A box at depth 2 or more (a value of
    // a value: the title of an end, a part of an inline list) gives no more values: the join reads no further.
    const queue: { f: Figure; reach: boolean; depth: number }[] = [];
    const include = (f: Figure | undefined, reach: boolean, depth: number) => {
        if (!f) return;
        const k = nkey(f.focus);
        if (!figOf.has(k)) { figOf.set(k, f); queue.push({ f, reach, depth }); } else if (reach && !reached.has(k) || depth < (depthOf.get(k) ?? Infinity)) queue.push({ f, reach, depth });
        depthOf.set(k, Math.min(depth, depthOf.get(k) ?? Infinity));
    };
    const depthOf = new Map<string, number>(), expanded = new Map<string, number>();
    const reached = new Set<string>();
    // The paths by which a line or a hub reaches another figure: their inverses lead from that figure to the line or hub.
    const reaching = shapes.filter(fs => fs.kind !== 'Box').flatMap(fs => fs.props.filter(p => LINKING.includes(p.role) && !p.value).map(p => inversePath(p.path)));
    const roots = new Set(scope.map(nkey));
    // A placed list figure names its list term (rule 12): its head from `listHeads`, checked; a miss reads all lists once.
    const lists = [...roots].filter(k => k.startsWith('<urn:trellis:list:'));
    const valid = (k: string) => { const h = listHeads.get(k); return !!h && nkey(listTerm(D, h) ?? h) === k; };
    if (lists.some(k => !valid(k))) {
        listHeads.clear();
        for (const head of D.subjectsOfP(RDF('first'))) {
            if (D.subjects(RDF('rest'), head).length) continue;
            const term = listTerm(D, head);
            if (term) listHeads.set(nkey(term), head);
        }
    }
    for (const k of lists) include(listHeads.has(k) ? decide(listHeads.get(k)!) : undefined, true, 0);
    for (const t of scope) {
        if (t.termType === 'Triple') for (const end of [t.subject, t.object]) include(decide(end), false, 1);
        else include(decide(t), true, 0);
    }
    for (let i = 0; i < queue.length; i++) {
        const { f, reach, depth } = queue[i];
        const k = nkey(f.focus);
        if (reach || f.fs.kind !== 'Box') {
            if (!reached.has(k)) {
                reached.add(k);
                for (const path of reaching) for (const x of evalPath(D, path, f.focus)) {
                    const g = decide(x);
                    if (g && g.fs.kind !== 'Box') include(g, true, 0);
                }
            }
        }
        const d = f.fs.kind === 'Box' ? depth : Math.min(depth, 1);
        if (f.fs.kind === 'Box' && depth >= 2 || (expanded.get(k) ?? Infinity) <= d) continue;
        expanded.set(k, d);
        for (const p of f.fs.props.filter(p => LINKING.includes(p.role) && holds(p.when, f.focus))) {
            const values = (p.value ? [p.value] : evalPath(D, p.path, f.focus)).filter(v => !p.select || p.select.some(s => nkey(s) === nkey(v)));
            for (const v of values) include(decide(v), false, d + 1);
        }
    }
}

const unplacedOf = (t: NTerm | undefined): 'AsRow' | 'Hidden' => t?.value === NT('Hidden') ? 'Hidden' : 'AsRow';

/**
 * nt:gatherWith nt:ModelShapes: the node shapes that target the focus. One row per value of a property shape: a property shape
 * without a value gives no row. The row title is sh:name of the property shape, else the local name of the predicate (as the app). The members of a logical
 * constraint (sh:xone, sh:or, sh:and) with sh:path are a row group, as in rule 7. A property shape with the path of the title role
 * gives no row: the title shows it. An IRI value is also a connector. Its row shows while the connector is not drawn (join).
 */
function gather(D: TripleIndex, f: Figure, warnings: string[], titlePaths: string[]): void {
    const classes = uniq(D.objects(f.focus, RDF('type')).flatMap(t => evalPath(D, { star: { p: NS.rdfs + 'subClassOf' } }, t)));
    const shapes = uniq([
        ...classes.flatMap(c => D.subjects(SH('targetClass'), c)),
        ...classes.filter(c => D.has(c, RDF('type'), iri(SH('NodeShape'))))      // implicit class target
    ]);
    const seen = new Set<string>();
    const rowsOf = (ps: NTerm): Row[] => {
        if (seen.has(nkey(ps))) return [];
        seen.add(nkey(ps));
        const path = D.one(ps, SH('path'));
        if (!path || D.one(path, RDF('first')) || D.objects(path, SH('inversePath')).length || D.objects(path, SH('alternativePath')).length) {
            warnings.push(`${f.id}: ${ps.value} has a complex path, not gathered`);
            return [];
        }
        if (titlePaths.includes(path.value)) return [];
        const values = D.objects(f.focus, path.value), name = D.one(ps, SH('name'))?.value ?? localName(path.value);
        return values.map(v => {
            const row: Row = { order: 0, rank: 0, text: `${name}: ${label(D, v)}`, gathered: ps };
            if (v.termType === 'NamedNode') {
                row.connector = { statement: triple(f.focus, path.value, v), gathered: ps, unplaced: unplacedOf(f.fs.unplaced), text: row.text };
                f.connectors.push(row.connector);
            }
            return row;
        });
    };
    // Rows in the order of the app: sh:order, then the row title.
    const nameOf = (ps: NTerm) => { const path = D.one(ps, SH('path')); return D.one(ps, SH('name'))?.value ?? (path ? localName(path.value) : ''); };
    const orderOf = (ps: NTerm) => Number(D.one(ps, SH('order'))?.value ?? Infinity);
    const byOrder = (a: NTerm, b: NTerm) => orderOf(a) - orderOf(b) || nameOf(a).localeCompare(nameOf(b));
    for (const s of shapes) {
        for (const ps of [...D.objects(s, SH('property'))].sort(byOrder)) f.rows.push(...rowsOf(ps));
        for (const op of ['xone', 'or', 'and']) for (const l of D.objects(s, SH(op))) {
            const members = D.list(l).filter(m => D.one(m, SH('path')));
            if (members.length) f.rows.push({ order: 0, rank: 0, text: op, sub: members.flatMap(rowsOf) });
        }
    }
}
