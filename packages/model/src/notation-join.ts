// The join of the figures of a view with its placements (ADR 0014; the join rule in docs/notation/notation.ttl), and the placement
// edits: removal, arrival and data arrival. Pure functions over the output of deriveFigures (notation.ts).

import { Connector, Derivation, Figure, Notations, deriveFigures, termLabel } from './notation';
import { NTerm, RDF, TripleIndex, V, iri, nkey, triple } from './notation-graph';
import { localName } from './terms';

/** A placement of a view: its IRI, its display and its geometry (absent on a line, optional on a hub). */
export interface NotationPlacement {
    iri: string; simple: boolean; keptByLines: boolean;
    x?: number; y?: number; width?: number; height?: number; color?: string; fromSide?: string; toSide?: string;
}
/** The placements of a view: placed term key → placement. */
export type Placements = Map<string, NotationPlacement>;

/** The placements of a view: `view:element` (an element) or `rdf:reifies` (a statement). */
export function placementsOf(D: TripleIndex, viewIri: string): Placements {
    const placed: Placements = new Map();
    for (const p of D.subjects(V('view'), iri(viewIri))) {
        const e = D.one(p, V('element')) ?? D.one(p, RDF('reifies'));
        if (!e) continue;
        const num = (l: string) => { const v = D.one(p, V(l)); return v && Number.isFinite(Number(v.value)) ? Number(v.value) : undefined; };
        const str = (l: string) => D.one(p, V(l))?.value;
        const geometry = Object.fromEntries((['x', 'y', 'width', 'height'] as const).map(k => [k, num(k)]).filter(([, v]) => v !== undefined));
        const style = Object.fromEntries((['color', 'fromSide', 'toSide'] as const).map(k => [k, str(k)]).filter(([, v]) => v !== undefined));
        placed.set(nkey(e), { iri: p.value, simple: str('display') === 'simple', keptByLines: str('keptByLines') === 'true', ...geometry, ...style });
    }
    return placed;
}

export type LineState = 'line' | 'hidden' | 'covered' | undefined;

/** The figures of a view and what the view draws. */
export interface ViewFigures { derivation: Derivation; placed: Placements; join: Join }

/** The figures of a view (`data`: the triples of the workspace) and their join with its placements. */
export function viewFigures(data: TripleIndex, notes: Notations, viewIri: string): ViewFigures {
    const derivation = deriveFigures(data, notes, viewIri), placed = placementsOf(data, viewIri);
    return { derivation, placed, join: join(derivation, placed) };
}

/** What a set of placements shows. */
export function joinState(figs: Figure[], placed: ReadonlyMap<string, unknown>) {
    const isPlaced = (f: Figure) => placed.has(nkey(f.placedAs));
    // An end with several candidates (a class with several node shapes): the first that this view places, else the first.
    for (const f of figs) if (f.ends.length > 1) f.end = f.ends.find(isPlaced) ?? f.ends[0];
    // Rule 7: a Line member is part of the hub unit. A Box member is an end of the hub: it needs its own placement.
    const hubOf = new Map<string, Figure>();
    for (const f of figs) if (f.fs.kind === 'Hub' && isPlaced(f)) for (const m of f.memberFigs) if (m.fs.kind === 'Line') hubOf.set(m.id, f);
    const memo = new Map<string, boolean>();
    // A private or open end is drawn beside the start: it needs no figure. Such a line shows only as a member of a shown hub.
    const endShown = (f: Figure) => f.endPrivate || shown(f.end);
    const shown = (f: Figure | undefined): boolean => {
        if (!f) return false;
        if (memo.has(f.id)) return memo.get(f.id)!;
        memo.set(f.id, false);
        let s = false;
        if (f.fs.kind === 'Box') s = isPlaced(f);
        else if (f.fs.kind === 'Line') s = (f.endPrivate ? hubOf.has(f.id) : isPlaced(f) || hubOf.has(f.id)) && endShown(f) && f.starts.some(shown);
        else s = isPlaced(f) && (!f.endValue || shown(f.end))
            && f.memberFigs.every(m => m.fs.kind === 'Line' ? endShown(m) && m.starts.some(shown) : shown(m));
        memo.set(f.id, s);
        return s;
    };
    // nt:covers: a shown hub draws the statement <member> <covered predicate> <end> of each member.
    const covered = new Set<string>();
    for (const f of figs) if (f.covers && f.endValue && shown(f)) for (const m of f.members) covered.add(nkey(triple(m, f.covers, f.endValue)));
    // The figure that a link end shows on: the figure, or a shown box that stands for it (nt:linkEnd, an entity group of a member).
    const linkEnd = (f: Figure | undefined): Figure | undefined => !f ? undefined : shown(f) ? f : f.carriers.find(shown);
    const showsEnd = (f: Figure | undefined) => Boolean(linkEnd(f));
    // Rule 8: a placed statement between two shown figures is a line. Hidden: a dashed line on selection, only when both ends are
    // shown. A statement that a shown hub covers is drawn by the hub. Otherwise the link is a row.
    const lineOf = (c: Connector): LineState => showsEnd(c.start) && showsEnd(c.end) ? (covered.has(nkey(c.statement)) ? 'covered'
        : placed.has(nkey(c.statement)) ? 'line' : c.unplaced === 'Hidden' ? 'hidden' : undefined) : undefined;
    return { isPlaced, hubOf, shown, endShown, covered, lineOf, linkEnd, showsEnd };
}

// --- the join ---------------------------------------------------------------------------------------

/** A row of a box. `connector`: the row stands for a link that is not drawn as a line. */
export interface JoinRow { text: string; part?: Figure; connector?: Connector; sub?: JoinRow[] }
export interface JoinBox { figure: Figure; simple: boolean; rows: JoinRow[] }
export interface JoinLine { figure: Figure; start: Figure; end?: Figure; endText: string; byHub?: Figure }
/** A link drawn as a line: its ends are the shown figures (an entity group for a member, nt:linkEnd). */
export interface JoinLink { connector: Connector; hidden: boolean; start: Figure; end: Figure }

/** What a view draws. */
export interface Join {
    boxes: JoinBox[];
    hubs: Figure[];
    lines: JoinLine[];
    /** A placed Box part, drawn as a part line from its owner (rule 5). */
    parts: { owner: Figure; part: Figure }[];
    links: JoinLink[];
    problems: string[];
}

export function join(d: Derivation, placed: Placements): Join {
    const figs = d.figures;
    const { isPlaced, hubOf, shown, lineOf, linkEnd } = joinState(figs, placed);
    const problems: string[] = [];
    for (const f of figs) {
        if (f.fs.kind !== 'Box' && isPlaced(f) && !shown(f)) problems.push(f.endPrivate && !hubOf.has(f.id)
            ? `placement of ${f.id}: a line with a private end shows only as a member of a hub (rule 7)`
            : `placement of ${f.id} needs ends that are not shown (rule 6)`);
        if (hubOf.has(f.id) && isPlaced(f)) problems.push(`${f.id} has an own placement and is a member of a placed hub (rule 7)`);
    }
    const known = new Set([...figs.map(f => nkey(f.placedAs)), ...figs.flatMap(f => f.connectors.map(c => nkey(c.statement)))]);
    for (const [k, p] of placed) if (!known.has(k)) problems.push(`placement ${p.iri} places ${k}, which has no figure or connector`);

    // A part is drawn from its owner: a Line that starts at the owner, a shown Hub, or a placed Box (a part line).
    const drawnFrom = (owner: Figure, pf?: Figure) => Boolean(pf && shown(pf) && (pf.fs.kind === 'Line' ? pf.starts.includes(owner) : true));
    const boxes: JoinBox[] = [];
    for (const f of figs.filter(f => shown(f) && f.fs.kind === 'Box')) {
        const visible = (r: { part?: Figure; connector?: Connector }) => !drawnFrom(f, r.part) && !(r.connector && lineOf(r.connector));
        const simple = Boolean(placed.get(nkey(f.placedAs))?.simple);
        const rows: JoinRow[] = simple ? [] : [
            ...f.rows.filter(visible).map(r => ({
                text: r.text, part: r.part, connector: r.connector,
                ...(r.sub ? { sub: r.sub.filter(visible).map(s => ({ text: s.text, part: s.part, connector: s.connector })) } : {})
            })),
            ...f.connectors.filter(c => !c.gathered && !lineOf(c)).map(c => ({ text: c.text, connector: c }))
        ];
        boxes.push({ figure: f, simple, rows });
    }
    const hubs = figs.filter(f => shown(f) && f.fs.kind === 'Hub');
    const lines: JoinLine[] = figs.filter(f => shown(f) && f.fs.kind === 'Line').flatMap(f => f.starts.filter(shown).map(s => ({
        figure: f, start: s, end: f.end,
        endText: f.end?.title ?? (f.endValue ? termLabel(d.data, f.endValue) : f.fs.openEnd ?? ''),
        byHub: hubOf.get(f.id)
    })));
    const parts = figs.filter(f => shown(f)).flatMap(o => o.rows.filter(r => r.part?.fs.kind === 'Box' && shown(r.part)).map(r => ({ owner: o, part: r.part! })));
    const links: JoinLink[] = [], listed = new Set<string>();
    for (const f of figs) for (const c of f.connectors) {
        if (listed.has(nkey(c.statement))) continue;
        listed.add(nkey(c.statement));
        const how = lineOf(c);
        if (how === 'line' || how === 'hidden') links.push({ connector: c, hidden: how === 'hidden', start: linkEnd(c.start)!, end: linkEnd(c.end)! });
    }
    return { boxes, hubs, lines, parts, links, problems };
}

/**
 * The member-list rule (ui-manifest §6.5), one for every container box: a node shape card, a value set, a "one of" box, an entity group.
 * A part of the box is a row unless the view draws it, as its own box or as a line from the box. `box`: the join box of the container;
 * absent (the view does not draw it with the notation engine): nothing is drawn from it, every part is a row. The test takes the focus
 * IRI of a part.
 */
export function partIsRow(box: JoinBox | undefined): (focus: string) => boolean {
    if (!box) return () => true;
    const focusOf = (rows: { part?: Figure; sub?: { part?: Figure }[] }[]) => new Set(rows.flatMap(r => [r, ...(r.sub ?? [])]).flatMap(r => r.part ? [r.part.focus.value] : []));
    const parts = focusOf(box.figure.rows), rows = focusOf(box.rows);
    return focus => !parts.has(focus) || rows.has(focus);
}

/** The join as text lines (test fixtures: packages/rdf/test/fixtures/notation/expected/*.join.txt). */
export function joinText(d: Derivation, j: Join): string[] {
    const shape = (f: Figure) => localName(f.fs.node.value);
    const out: string[] = [`view: ${d.figures.length} figures`];
    for (const b of j.boxes) {
        const f = b.figure;
        out.push(`box   ${f.tags.join(' ')}${f.tags.length ? ' ' : ''}${f.title}   (${shape(f)})${b.simple ? '   simple' : ''}`);
        for (const r of b.rows) {
            out.push(`        ${r.text}`);
            for (const s of r.sub ?? []) out.push(`          ${s.text}`);
        }
    }
    for (const h of j.hubs) out.push(`hub   ${h.title}${h.end ? ' → ' + h.end.title : ''}   members: ${h.memberFigs.map(m => m.title).join(', ')}   (${shape(h)})`);
    for (const l of j.lines) out.push(`line  ${l.start.title} → ${l.end ? l.end.title : l.endText + ' (private pill)'}   "${l.figure.text}"`
        + `${l.figure.tags.length ? ' ' + l.figure.tags.join(' ') : ''}${l.byHub ? '   (by hub ' + l.byHub.title + ')' : ''}`);
    for (const p of j.parts) out.push(`part  ${p.owner.title} → ${p.part.title}`);
    for (const l of j.links) out.push(l.hidden
        ? `hidden ${l.start.title} → ${l.end.title}   "${l.connector.text}"   (dashed while an end is selected)`
        : `link  ${l.start.title} → ${l.end.title}   "${l.connector.text}"`);
    for (const w of [...d.warnings, ...j.problems]) out.push(`! ${w}`);
    return out;
}

// --- edits ------------------------------------------------------------------------------------------

/** A term that a user names: a list head stands for its placed term (rule 12). */
export function placedTerm(figs: Figure[], t: NTerm): NTerm {
    return figs.find(f => nkey(f.focus) === nkey(t))?.placedAs ?? t;
}

/**
 * The placed terms (keys) that a removal of `t` takes with it: the placements that need a figure that is no longer shown (rule 6),
 * and each box kept by lines (nt:keptByLines, view:keptByLines) whose last line this removal took.
 */
export function removal(figs: Figure[], placed: Placements, t: NTerm): string[] {
    const before = new Map(placed), after = new Map(placed);
    after.delete(nkey(t));
    // What keeps a box: a shown line or hub member line that ends at it (ui-manifest §2.9 linesTo). A line that starts at the box (an
    // alternative from its "one of" box) does not keep it.
    const lineEnds = (s: ReturnType<typeof joinState>) => new Set(figs.filter(f => f.fs.kind !== 'Box' && s.shown(f)).flatMap(f => [f.end,
        ...(f.fs.kind === 'Hub' ? f.memberFigs.flatMap(m => m.fs.kind === 'Line' ? [m.end] : [m]) : [])]).filter(Boolean).map(f => f!.id));
    const endsBefore = lineEnds(joinState(figs, before));
    const kept = (f: Figure) => f.fs.keptByLines || Boolean(before.get(nkey(f.placedAs))?.keptByLines);
    for (let changed = true; changed;) {
        changed = false;
        const s = joinState(figs, after);
        for (const f of figs) if (f.fs.kind !== 'Box' && after.has(nkey(f.placedAs)) && !s.shown(f)) { after.delete(nkey(f.placedAs)); changed = true; }
        for (const f of figs) for (const c of f.connectors) if (after.has(nkey(c.statement)) && s.lineOf(c) !== 'line') { after.delete(nkey(c.statement)); changed = true; }
        const endsNow = lineEnds(joinState(figs, after));
        for (const f of figs) if (kept(f) && after.has(nkey(f.placedAs)) && endsBefore.has(f.id) && !endsNow.has(f.id)) { after.delete(nkey(f.placedAs)); changed = true; }
    }
    return [...before.keys()].filter(k => !after.has(k));
}

/**
 * The placed terms (keys) that an arrival of `t` brings with it (rule 11). A user places t (add, drag, paste, expand). Then, until
 * nothing changes: each hub whose ends are all shown, each line with a shown start and end, and each link between two shown figures
 * that no shown hub covers. Only what touches a figure placed by this arrival. The first key is t.
 */
export function arrival(figs: Figure[], placed: Placements, t: NTerm): string[] {
    const after = new Map<string, unknown>(placed), added = [nkey(t)];
    after.set(nkey(t), 'new');
    const touches = (f?: Figure) => Boolean(f && added.includes(nkey(f.placedAs)));
    grow(figs, after, added, touches);
    return added;
}

/**
 * Data arrival (ADR 0014): a data change adds statements or Line figures (`terms`, keys of new connectors and new figure
 * foci). Each one whose start and end are shown gets a placement, in the same command. A line with a
 * private or open end and a hub member never arrive alone. Returns the placed term keys.
 */
export function dataArrival(figs: Figure[], placed: Placements, terms: ReadonlySet<string>): string[] {
    const s = joinState(figs, placed), out: string[] = [];
    const inHub = new Set(figs.filter(f => f.fs.kind === 'Hub').flatMap(h => h.memberFigs.filter(m => m.fs.kind === 'Line').map(m => m.id)));
    for (const l of figs) if (l.fs.kind === 'Line' && terms.has(nkey(l.focus)) && !s.isPlaced(l) && !l.endPrivate && !inHub.has(l.id)
        && s.shown(l.end) && l.starts.some(s.shown)) out.push(nkey(l.placedAs));
    for (const f of figs) for (const c of f.connectors) {
        const k = nkey(c.statement);
        if (terms.has(k) && !placed.has(k) && !out.includes(k) && s.showsEnd(c.start) && s.showsEnd(c.end) && !s.covered.has(k)) out.push(k);
    }
    return out;
}

function grow(figs: Figure[], after: Map<string, unknown>, added: string[], touches: (f?: Figure) => boolean): void {
    const inHub = new Set(figs.filter(f => f.fs.kind === 'Hub').flatMap(h => h.memberFigs.filter(m => m.fs.kind === 'Line').map(m => m.id)));
    for (let changed = true; changed;) {
        changed = false;
        const add = (k: string) => { if (!after.has(k)) { after.set(k, 'new'); added.push(k); changed = true; } };
        let s = joinState(figs, after);
        for (const h of figs.filter(f => f.fs.kind === 'Hub' && !s.isPlaced(f))) {
            const ends = [h.end, ...h.memberFigs.flatMap(m => m.fs.kind === 'Line' ? [m.end, ...m.starts] : [m])];
            const ready = (!h.endValue || s.shown(h.end)) && h.memberFigs.every(m => m.fs.kind === 'Line' ? s.endShown(m) && m.starts.some(s.shown) : s.shown(m));
            if (ready && ends.some(touches)) add(nkey(h.placedAs));
        }
        s = joinState(figs, after);
        // A private or open end does not arrive: such a line shows only as a hub member.
        for (const l of figs.filter(f => f.fs.kind === 'Line' && !s.isPlaced(f) && !inHub.has(f.id)))
            if (s.shown(l.end) && l.starts.some(s.shown) && [l.end, ...l.starts].some(touches)) add(nkey(l.placedAs));
        s = joinState(figs, after);
        for (const f of figs) for (const c of f.connectors)
            if (s.showsEnd(c.start) && s.showsEnd(c.end) && !s.covered.has(nkey(c.statement)) && (touches(s.linkEnd(c.start)) || touches(s.linkEnd(c.end)))) add(nkey(c.statement));
    }
}

