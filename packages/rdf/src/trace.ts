// The trace of the backend (the Trace panel, @catenary/model trace.ts). One tracer for the process: the store, the validation, the
// RPC service and the diagram sessions record into it. It records only while a client asks for it; off, a hook costs one boolean check.
// AsyncLocalStorage gives each span its cause: a span that starts inside another (also after an await or a timer) is its child.

import { TraceBatch, TraceKind, TraceSpan, TraceStat, queryKey } from '@catenary/model';
import type { Quad, Term } from '@rdfjs/types';
import { AsyncLocalStorage } from 'async_hooks';
import { performance } from 'perf_hooks';
import type { Bindings, QuadStore } from 'rdf-files';

/** A span that runs. Quad-store calls add to it and to its ancestors. */
interface Open {
    id: number;
    parent?: Open;
    queries: number;
    queryMs: number;
    detail?: string;
    size?: number;
}

/** Spans kept for clients to read. Older spans drop. */
const CAPACITY = 3000;
/** Keys in the totals. More keys add to one "(other keys)" row of their kind. */
const MAX_KEYS = 2000;
/** Characters of a query kept in the detail of its span. */
const MAX_DETAIL = 4000;

const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as PromiseLike<unknown>).then === 'function';

export class Tracer {
    /** Recording is on. Read it before you build a span name that costs time. */
    on = false;
    protected clients = 0;
    protected readonly context = new AsyncLocalStorage<Open | undefined>();
    protected nextId = 0;
    /** Spans in the order they ended; `seq` is the number of the last one. */
    protected spans: TraceSpan[] = [];
    protected seq = 0;
    protected readonly stats = new Map<string, TraceStat>();

    /** A client starts (true) or stops (false) reading. Recording is on while one client or more read. Off clears all data. */
    setClient(on: boolean): void {
        this.clients = Math.max(0, this.clients + (on ? 1 : -1));
        this.on = this.clients > 0;
        if (!this.on) this.clear();
    }

    clear(): void {
        this.spans = [];
        this.stats.clear();
    }

    /** The spans that ended after `since` (a `seq` of an earlier batch; 0: all kept spans) and all totals. */
    take(since = 0): TraceBatch {
        const first = this.seq - this.spans.length + 1;
        const from = Math.max(0, since + 1 - first);
        return {
            seq: this.seq,
            spans: this.spans.slice(from),
            stats: [...this.stats.values()].map(s => ({ ...s })),
            on: this.on,
            dropped: since > 0 && since + 1 < first ? first - since - 1 : 0
        };
    }

    /** Run `fn` as a span. A promise result ends the span when it settles. */
    span<T>(kind: TraceKind, name: string, fn: () => T): T {
        if (!this.on) return fn();
        const open: Open = { id: ++this.nextId, parent: this.context.getStore(), queries: 0, queryMs: 0 };
        const start = Date.now(), t0 = performance.now();
        const end = (error: boolean) => this.record(open, { kind, name, start, ms: performance.now() - t0, error });
        let r: T;
        try {
            r = this.context.run(open, fn);
        } catch (e) {
            end(true);
            throw e;
        }
        if (!isThenable(r)) {
            end(false);
            return r;
        }
        return Promise.resolve(r).then(v => { end(false); return v; }, e => { end(true); throw e; }) as T;
    }

    /** Run `fn` as a span without a parent: for work that a watcher starts, not the span that set up the watcher. */
    root<T>(kind: TraceKind, name: string, fn: () => T): T {
        return this.on ? this.context.run(undefined, () => this.span(kind, name, fn)) : fn();
    }

    /** A span without duration: something that happened (for example a scheduled validation). */
    event(kind: TraceKind, name: string, detail?: string): void {
        if (!this.on) return;
        this.record({ id: ++this.nextId, parent: this.context.getStore(), queries: 0, queryMs: 0, detail }, { kind, name, start: Date.now(), ms: 0 });
    }

    /** Set the detail text and the size of the running span. */
    note(detail?: string, size?: number): void {
        const open = this.on ? this.context.getStore() : undefined;
        if (!open) return;
        if (detail !== undefined) open.detail = detail;
        if (size !== undefined) open.size = size;
    }

    /** A SPARQL query: a span of its own, with the query as detail and the rows as size. */
    sparql<T extends unknown[]>(form: 'select' | 'construct', query: string, fn: () => T): T {
        if (!this.on) return fn();
        const parent = this.context.getStore();
        const start = Date.now(), t0 = performance.now();
        let rows: T | undefined;
        try {
            rows = fn();
            return rows;
        } finally {
            const ms = performance.now() - t0;
            this.addQuery(parent, ms);
            this.record({ id: ++this.nextId, parent, queries: 1, queryMs: ms, detail: query.length > MAX_DETAIL ? query.slice(0, MAX_DETAIL) + '…' : query, size: rows?.length },
                { kind: 'sparql', name: `${form}: ${queryKey(query)}`, start, ms, error: !rows });
        }
    }

    /** A pattern match: only in the totals and in the counts of the running spans (there are too many for spans of their own). */
    match(pattern: string, fn: () => Quad[]): Quad[] {
        if (!this.on) return fn();
        const t0 = performance.now();
        const quads = fn();
        const ms = performance.now() - t0;
        this.addQuery(this.context.getStore(), ms);
        this.addStat('match', pattern, ms, quads.length, Date.now());
        return quads;
    }

    protected addQuery(open: Open | undefined, ms: number): void {
        for (let o = open; o; o = o.parent) {
            o.queries++;
            o.queryMs += ms;
        }
    }

    protected record(open: Open, s: Pick<TraceSpan, 'kind' | 'name' | 'start' | 'ms' | 'error'>): void {
        const span: TraceSpan = { id: open.id, kind: s.kind, name: s.name, start: s.start, ms: round(s.ms) };
        if (open.parent) span.parent = open.parent.id;
        if (open.detail !== undefined) span.detail = open.detail;
        if (open.queries) { span.queries = open.queries; span.queryMs = round(open.queryMs); }
        if (open.size !== undefined) span.size = open.size;
        if (s.error) span.error = true;
        this.spans.push(span);
        this.seq++;
        if (this.spans.length > CAPACITY * 1.2) this.spans = this.spans.slice(-CAPACITY);
        this.addStat(s.kind, s.name, s.ms, open.size ?? 0, s.start);
    }

    protected addStat(kind: TraceStat['kind'], name: string, ms: number, size: number, at: number): void {
        let key = `${kind} ${name}`;
        if (!this.stats.has(key) && this.stats.size >= MAX_KEYS) {
            name = '(other keys)';
            key = `${kind} ${name}`;
        }
        let stat = this.stats.get(key);
        if (!stat) this.stats.set(key, stat = { kind, name, calls: 0, totalMs: 0, maxMs: 0, size: 0, last: at });
        stat.calls++;
        stat.totalMs = round(stat.totalMs + ms);
        stat.maxMs = Math.max(stat.maxMs, round(ms));
        stat.size += size;
        stat.last = at;
    }
}

const round = (ms: number) => Math.round(ms * 1000) / 1000;

/** The tracer of the process. */
export const tracer = new Tracer();

/** The last segment of an IRI, for the name of a match pattern. */
const local = (t: Term) => t.termType === 'NamedNode' ? t.value.replace(/^.*[#/:]/, '') || t.value : t.termType === 'Literal' ? '"…"' : '?';

/**
 * A quad store that reports its queries to the tracer. `has`, `add` and `delete` are not reported: they are cheap and an edit or a read
 * calls them very often. A match gets a name from its pattern: S and O for a given subject and object, the predicate and the graph by name.
 */
export class TracedStore implements QuadStore {
    constructor(protected readonly inner: QuadStore) {}

    get size(): number { return this.inner.size; }
    has(q: Quad): boolean { return this.inner.has(q); }
    add(q: Quad): void { this.inner.add(q); }
    delete(q: Quad): void { this.inner.delete(q); }

    match(s?: Term | null, p?: Term | null, o?: Term | null, g?: Term | null): Quad[] {
        if (!tracer.on) return this.inner.match(s, p, o, g);
        const pattern = `match(${s ? 'S' : '?'} ${p ? local(p) : '?'} ${o ? 'O' : '?'} ${g ? local(g) : '?'})`;
        return tracer.match(pattern, () => this.inner.match(s, p, o, g));
    }

    select(query: string): Bindings[] {
        return tracer.on ? tracer.sparql('select', query, () => this.inner.select(query)) : this.inner.select(query);
    }

    construct(query: string): Quad[] {
        return tracer.on ? tracer.sparql('construct', query, () => this.inner.construct(query)) : this.inner.construct(query);
    }
}
