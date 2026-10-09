// The input of the notation engine (notation.ts): triples as JSON, an index over them, SHACL paths, and nt:when conformance.
// No RDF library. @catenary/rdf reads the store and the built-in notation files into NQuad arrays (notations.ts there).
// There are no blank nodes: the store skolemizes them at read (AGENTS.md), and so does the notation loader.

import { PathJSON } from './shapes-doc';
import { NS, TermJSON } from './terms';

/** An RDF 1.2 triple term: the statement that a placement names with rdf:reifies. `value` is empty, as for an RDF/JS quad. */
export interface TripleTerm { termType: 'Triple'; value: ''; subject: NTerm; predicate: TermJSON; object: NTerm }
export type NTerm = TermJSON | TripleTerm;
/** A triple of the union of all graphs. */
export interface NQuad { subject: TermJSON; predicate: string; object: NTerm }

export const NT = (l: string) => 'osg://vocab/notation#' + l;
export const SH = (l: string) => NS.sh + l;
export const RDF = (l: string) => NS.rdf + l;
export const V = (l: string) => NS.view + l;
export const iri = (value: string): TermJSON => ({ termType: 'NamedNode', value });
export const triple = (s: NTerm, p: string, o: NTerm): TripleTerm => ({ termType: 'Triple', value: '', subject: s, predicate: iri(p), object: o });

/** Stable text of a term. */
export function nkey(t: NTerm): string {
    if (t.termType === 'Triple') return `<<(${nkey(t.subject)} ${nkey(t.predicate)} ${nkey(t.object)})>>`;
    return t.termType === 'NamedNode' ? `<${t.value}>` : JSON.stringify([t.value, t.datatype ?? '', t.language ?? '']);
}

export function uniq<T extends NTerm>(ts: T[]): T[] {
    const seen = new Set<string>();
    return ts.filter(t => !seen.has(nkey(t)) && Boolean(seen.add(nkey(t))));
}

/**
 * A triple index over the union of all graphs. Values are sorted by term key. `add` and `delete` keep it in step with a store, so that
 * a change does not build it again. They replace the arrays that `objects` and `subjects` return: a caller keeps the values it read.
 */
export class TripleIndex {
    readonly out = new Map<string, Map<string, NTerm[]>>();
    readonly inv = new Map<string, Map<string, TermJSON[]>>();
    protected readonly byP = new Map<string, { s: TermJSON[]; o: NTerm[] }>();
    /** The number of graphs that have each triple: the union has a triple while one graph or more has it. */
    protected readonly counts = new Map<string, number>();

    constructor(quads: readonly NQuad[] = []) {
        for (const x of quads) {
            const k = tripleKey(x);
            const n = this.counts.get(k) ?? 0;
            this.counts.set(k, n + 1);
            if (n) continue;
            push(this.out, nkey(x.subject), x.predicate, x.object);
            push(this.inv, nkey(x.object), x.predicate, x.subject);
            const p = this.byP.get(x.predicate) ?? this.byP.set(x.predicate, { s: [], o: [] }).get(x.predicate)!;
            p.s.push(x.subject); p.o.push(x.object);
        }
        // The store has no statement order: sort the values, so that the output does not depend on it. RDF lists keep their order.
        for (const m of [this.out, this.inv]) for (const byP of m.values()) for (const vs of byP.values()) vs.sort(byKey);
        for (const p of this.byP.values()) { p.s.sort(byKey); p.o.sort(byKey); }
    }

    /** One more graph has the triple. */
    add(x: NQuad): void {
        const k = tripleKey(x);
        const n = this.counts.get(k) ?? 0;
        this.counts.set(k, n + 1);
        if (n) return;
        insert(this.out, nkey(x.subject), x.predicate, x.object);
        insert(this.inv, nkey(x.object), x.predicate, x.subject);
        const p = this.byP.get(x.predicate) ?? this.byP.set(x.predicate, { s: [], o: [] }).get(x.predicate)!;
        p.s.splice(sortedIndex(p.s, nkey(x.subject)), 0, x.subject);
        p.o.splice(sortedIndex(p.o, nkey(x.object)), 0, x.object);
    }

    /** One graph less has the triple. */
    delete(x: NQuad): void {
        const k = tripleKey(x);
        const n = this.counts.get(k);
        if (!n) return;
        if (n > 1) return void this.counts.set(k, n - 1);
        this.counts.delete(k);
        remove(this.out, nkey(x.subject), x.predicate, nkey(x.object));
        remove(this.inv, nkey(x.object), x.predicate, nkey(x.subject));
        const p = this.byP.get(x.predicate);
        if (!p) return;
        removeOne(p.s, nkey(x.subject));
        removeOne(p.o, nkey(x.object));
        if (!p.s.length) this.byP.delete(x.predicate);
    }

    objects(s: NTerm, p: string): NTerm[] { return this.out.get(nkey(s))?.get(p) ?? []; }
    subjects(p: string, o: NTerm): TermJSON[] { return this.inv.get(nkey(o))?.get(p) ?? []; }
    one(s: NTerm, p: string): NTerm | undefined { return this.objects(s, p)[0]; }
    has(s: NTerm, p: string, o: NTerm): boolean { return this.objects(s, p).some(x => nkey(x) === nkey(o)); }
    subjectsOfP(p: string): TermJSON[] { return uniq(this.byP.get(p)?.s ?? []); }
    objectsOfP(p: string): NTerm[] { return uniq(this.byP.get(p)?.o ?? []); }
    /** The members of an RDF list, in order. */
    list(head: NTerm | undefined): NTerm[] {
        const out: NTerm[] = [], seen = new Set<string>();
        for (let n = head; n && n.value !== RDF('nil') && !seen.has(nkey(n)); n = this.one(n, RDF('rest'))) {
            seen.add(nkey(n));
            const f = this.one(n, RDF('first'));
            if (f) out.push(f);
        }
        return out;
    }
}

function push<T>(m: Map<string, Map<string, T[]>>, k: string, p: string, v: T): void {
    const byP = m.get(k) ?? m.set(k, new Map()).get(k)!;
    (byP.get(p) ?? byP.set(p, []).get(p)!).push(v);
}

const tripleKey = (x: NQuad) => `${nkey(x.subject)} ${x.predicate} ${nkey(x.object)}`;
const byKey = (a: NTerm, b: NTerm) => { const ka = nkey(a), kb = nkey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; };

/** The first position in sorted `vs` whose key is not below `k`. */
function sortedIndex(vs: readonly NTerm[], k: string): number {
    let lo = 0, hi = vs.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (nkey(vs[mid]) < k) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/** Add `v` in sorted position, in a new array (a caller can hold the old one). */
function insert<T extends NTerm>(m: Map<string, Map<string, T[]>>, k: string, p: string, v: T): void {
    const byP = m.get(k) ?? m.set(k, new Map()).get(k)!;
    const vs = byP.get(p) ?? [];
    const i = sortedIndex(vs, nkey(v));
    byP.set(p, [...vs.slice(0, i), v, ...vs.slice(i)]);
}

/** Remove the value with key `vk`, in a new array (a caller can hold the old one). */
function remove<T extends NTerm>(m: Map<string, Map<string, T[]>>, k: string, p: string, vk: string): void {
    const byP = m.get(k), vs = byP?.get(p);
    if (!byP || !vs) return;
    const i = sortedIndex(vs, vk);
    if (i >= vs.length || nkey(vs[i]) !== vk) return;
    if (vs.length === 1) {
        byP.delete(p);
        if (!byP.size) m.delete(k);
    } else byP.set(p, [...vs.slice(0, i), ...vs.slice(i + 1)]);
}

/** Remove one value with key `vk` in place (the per-predicate lists: callers read them through `uniq`, a copy). */
function removeOne(vs: NTerm[], vk: string): void {
    const i = sortedIndex(vs, vk);
    if (i < vs.length && nkey(vs[i]) === vk) vs.splice(i, 1);
}

// --- SHACL paths --------------------------------------------------------------------------------

export type Path = { p: string } | { rev: string } | { inv: Path } | { seq: Path[] } | { alt: Path[] } | { star: Path } | { plus: Path } | { opt: Path };

/** A SHACL path node as a tree. */
export function parseShaclPath(G: TripleIndex, node: NTerm): Path {
    if (G.one(node, RDF('first'))) return { seq: G.list(node).map(n => parseShaclPath(G, n)) };
    const one = (l: string) => G.one(node, SH(l));
    const x = one('inversePath') ?? one('zeroOrMorePath') ?? one('oneOrMorePath') ?? one('zeroOrOnePath');
    if (x) return one('inversePath') ? { inv: parseShaclPath(G, x) } : one('zeroOrMorePath') ? { star: parseShaclPath(G, x) }
        : one('oneOrMorePath') ? { plus: parseShaclPath(G, x) } : { opt: parseShaclPath(G, x) };
    const alt = one('alternativePath');
    if (alt) return { alt: G.list(alt).map(n => parseShaclPath(G, n)) };
    return { p: node.value };
}

/** A SHACL path node as PathJSON (shapes-doc.ts), for its text (`formatPath`). Repetition paths are 'unsupported', as in the shapes read. */
export function pathJSON(G: TripleIndex, node: NTerm): PathJSON {
    const tree = (p: Path): PathJSON => 'p' in p ? { kind: 'iri', iri: p.p } : 'inv' in p ? { kind: 'inverse', path: tree(p.inv) }
        : 'seq' in p ? { kind: 'sequence', items: p.seq.map(tree) } : 'alt' in p ? { kind: 'alternative', items: p.alt.map(tree) }
        : { kind: 'unsupported', text: 'star' in p ? '*' : 'plus' in p ? '+' : '?' };
    return tree(parseShaclPath(G, node));
}

function inverse(path: Path): Path {
    if ('p' in path) return { rev: path.p };
    if ('rev' in path) return { p: path.rev };
    if ('inv' in path) return path.inv;
    if ('seq' in path) return { seq: path.seq.map(inverse).reverse() };
    if ('alt' in path) return { alt: path.alt.map(inverse) };
    if ('star' in path) return { star: inverse(path.star) };
    if ('plus' in path) return { plus: inverse(path.plus) };
    return { opt: inverse(path.opt) };
}

/** The values of a path from a node, in order (a list path keeps list order). */
export function evalPath(D: TripleIndex, path: Path, node: NTerm): NTerm[] {
    if ('p' in path) return D.objects(node, path.p);
    if ('rev' in path) return D.subjects(path.rev, node);
    if ('inv' in path) return evalPath(D, inverse(path.inv), node);
    if ('seq' in path) return path.seq.reduce<NTerm[]>((nodes, step) => uniq(nodes.flatMap(n => evalPath(D, step, n))), [node]);
    if ('alt' in path) return uniq(path.alt.flatMap(a => evalPath(D, a, node)));
    const inner = 'star' in path ? path.star : 'plus' in path ? path.plus : path.opt;
    const out: NTerm[] = 'plus' in path ? [] : [node];
    let frontier = [node];
    for (let depth = 0; frontier.length && !('opt' in path && depth === 1); depth++) {
        frontier = uniq(frontier.flatMap(n => evalPath(D, inner, n))).filter(n => !out.some(o => nkey(o) === nkey(n)));
        out.push(...frontier);
    }
    return out;
}

/** The classes of a node, with their superclasses (rdfs:subClassOf*). */
export const classesOf = (D: TripleIndex, n: NTerm): NTerm[] =>
    uniq(D.objects(n, RDF('type')).flatMap(t => evalPath(D, { star: { p: NS.rdfs + 'subClassOf' } }, t)));

// --- nt:when: conformance of a focus to a condition ------------------------------------------------
//
// The one place where the conditions of the notations (nt:when) are tested. Plain checks for the SHACL terms that the notations
// use; any other term is an error, so a new term in a notation shows here first. It is not validation and writes nothing.

const CHECKED = new Set(['property', 'not', 'or', 'class', 'closed', 'ignoredProperties', 'path', 'minCount', 'maxCount', 'node', 'hasValue']);

/** `N`: the notation triples (the condition). `D`: the data triples (the focus). */
export function conforms(D: TripleIndex, N: TripleIndex, shape: NTerm, focus: NTerm): boolean {
    for (const p of N.out.get(nkey(shape))?.keys() ?? []) {
        if (p.startsWith(NS.sh) && !CHECKED.has(p.slice(NS.sh.length))) throw new Error(`nt:when uses ${p}: not supported by conforms()`);
    }
    for (const x of N.objects(shape, SH('not'))) if (conforms(D, N, x, focus)) return false;
    for (const l of N.objects(shape, SH('or'))) if (!N.list(l).some(x => conforms(D, N, x, focus))) return false;
    for (const c of N.objects(shape, SH('class'))) if (!classesOf(D, focus).some(k => nkey(k) === nkey(c))) return false;
    const allowed = new Set(N.list(N.one(shape, SH('ignoredProperties'))).map(t => t.value));
    for (const ps of N.objects(shape, SH('property'))) {
        const path = parseShaclPath(N, N.one(ps, SH('path'))!);
        if ('p' in path) allowed.add(path.p);
        const values = evalPath(D, path, focus);
        const min = N.one(ps, SH('minCount')), max = N.one(ps, SH('maxCount'));
        if (min && values.length < Number(min.value)) return false;
        if (max && values.length > Number(max.value)) return false;
        for (const h of N.objects(ps, SH('hasValue'))) if (!values.some(v => nkey(v) === nkey(h))) return false;
        for (const c of N.objects(ps, SH('class'))) if (!values.every(v => classesOf(D, v).some(k => nkey(k) === nkey(c)))) return false;
        for (const n of N.objects(ps, SH('node'))) if (!values.every(v => conforms(D, N, n, v))) return false;
    }
    if (N.one(shape, SH('closed'))?.value === 'true') {
        for (const p of D.out.get(nkey(focus))?.keys() ?? []) if (!allowed.has(p)) return false;
    }
    return true;
}
