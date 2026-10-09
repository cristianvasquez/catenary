// The trace of the backend (the Trace panel): what ran, what caused it and how long it took. The backend records only while a client
// asks for it (ModelService.setTracing), so a closed panel costs one boolean check per hook.

/** What a span measures. */
export type TraceKind =
    /** A request from a client (browser window, CLI). */
    | 'rpc'
    /** An edit command, undo or redo. */
    | 'command'
    /** A change event of the store and the listeners that it calls. */
    | 'change'
    /** A snapshot sent to a client after a change. */
    | 'snapshot'
    /** A diagram session sends its view again. */
    | 'refresh'
    /** A SHACL target read: scope, references, and checked-node walk. */
    | 'shacl'
    /** A SHACL validation: scheduled, run, discarded. */
    | 'validation'
    /** A SPARQL query (select, construct) on the quad store. */
    | 'sparql'
    /** File writes and reads after a change on disk. */
    | 'file'
    /** A request as the browser measured it: the round trip, with the size of the answer. */
    | 'roundtrip'
    /** Input to the first visible model DOM change and a paint opportunity. */
    | 'paint';

export const TRACE_KINDS: readonly TraceKind[] = ['rpc', 'command', 'change', 'snapshot', 'refresh', 'shacl', 'validation', 'sparql', 'file', 'roundtrip', 'paint'];

/** One measured operation. `parent`: the span that caused it (its id), which can end after this span. */
export interface TraceSpan {
    id: number;
    parent?: number;
    kind: TraceKind;
    name: string;
    /** Start time (ms since the epoch). */
    start: number;
    /** Duration (ms). */
    ms: number;
    /** Extra text: a full query, a result, a reason. */
    detail?: string;
    /** Quad-store calls in this span and its children: count and time (ms). */
    queries?: number;
    queryMs?: number;
    /** Result rows (a query) or bytes (a round trip). */
    size?: number;
    error?: boolean;
}

/** Totals of one key (kind and name) since the trace started or was cleared. */
export interface TraceStat {
    kind: TraceKind | 'match';
    name: string;
    calls: number;
    totalMs: number;
    maxMs: number;
    /** Rows or bytes, summed. */
    size: number;
    /** Time of the last call (ms since the epoch). */
    last: number;
}

/** The spans after `seq` and all totals. */
export interface TraceBatch {
    /** Pass it as `since` to get only newer spans. */
    seq: number;
    spans: TraceSpan[];
    stats: TraceStat[];
    /** Recording is on (a client asked for it). */
    on: boolean;
    /** Spans that the buffer dropped before a client read them. */
    dropped: number;
    /** Latest 600 backend timer-delay samples (50 ms interval), shared by tracing connections. */
    loopDelay?: number[];
}

/**
 * The key of a query in the totals: the query with IRIs, literals and numbers replaced, so that the same query for other elements
 * adds to one row. One line, at most 160 characters.
 */
export function queryKey(query: string): string {
    const key = query
        .replace(/^\s*(?:PREFIX\s+\S*\s*<[^>]*>\s*)+/i, '')
        .replace(/<[^>\s]*>/g, '<…>')
        .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
        .replace(/\b\d+(?:\.\d+)?\b/g, 'N')
        .replace(/\s+/g, ' ')
        .trim();
    return key.length > 160 ? key.slice(0, 159) + '…' : key;
}
