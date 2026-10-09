// The browser half of the trace (the Trace panel): the round trip of each ModelService request and the size of its answer. Records only
// while the Trace panel records (`on`).

import { injectable } from '@theia/core/shared/inversify';
import { TraceSpan, TraceStat } from '@catenary/model';

/** Calls that the trace does not measure: the trace itself and the RPC plumbing. */
const UNTRACED = new Set(['setClient', 'getClient', 'dispose', 'setTracing', 'trace', 'clearTrace', 'then']);

@injectable()
export class FrontendTrace {
    on = false;
    /** Negative ids: they do not collide with the ids of the backend. */
    protected nextId = 0;
    protected fresh: TraceSpan[] = [];
    protected readonly totals = new Map<string, TraceStat>();

    record(name: string, start: number, ms: number, size: number, error: boolean): void {
        ms = Math.round(ms * 1000) / 1000;
        const span: TraceSpan = { id: -++this.nextId, kind: 'roundtrip', name, start, ms, size };
        if (error) span.error = true;
        this.fresh.push(span);
        if (this.fresh.length > 3000) this.fresh = this.fresh.slice(-2000);
        let stat = this.totals.get(name);
        if (!stat) this.totals.set(name, stat = { kind: 'roundtrip', name, calls: 0, totalMs: 0, maxMs: 0, size: 0, last: start });
        stat.calls++;
        stat.totalMs += ms;
        stat.maxMs = Math.max(stat.maxMs, ms);
        stat.size += size;
        stat.last = start;
    }

    /** The spans since the last call. */
    take(): TraceSpan[] {
        const spans = this.fresh;
        this.fresh = [];
        return spans;
    }

    stats(): TraceStat[] {
        return [...this.totals.values()].map(s => ({ ...s }));
    }

    clear(): void {
        this.fresh = [];
        this.totals.clear();
    }
}

const sizeOf = (value: unknown): number => {
    try {
        return JSON.stringify(value)?.length ?? 0;
    } catch {
        return 0;
    }
};

/** `service` with the round trip of each call recorded in `trace` while it is on. */
export function tracedService<T extends object>(service: T, trace: FrontendTrace): T {
    const wrapped = new Map<string, unknown>();
    return new Proxy(service, {
        get(target, name) {
            const value: unknown = Reflect.get(target, name);
            if (typeof value !== 'function' || typeof name !== 'string' || UNTRACED.has(name)) return value;
            let fn = wrapped.get(name);
            if (!fn) {
                const call = value as (...args: unknown[]) => unknown;
                wrapped.set(name, fn = (...args: unknown[]) => {
                    if (!trace.on) return call.apply(target, args);
                    const start = Date.now(), t0 = performance.now();
                    return Promise.resolve(call.apply(target, args)).then(
                        r => { trace.record(name, start, performance.now() - t0, sizeOf(r), false); return r; },
                        e => { trace.record(name, start, performance.now() - t0, 0, true); throw e; });
                });
            }
            return fn;
        }
    });
}
