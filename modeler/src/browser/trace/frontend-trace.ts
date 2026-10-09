// The browser half of the trace (the Trace panel): the round trip of each ModelService request and the size of its answer. Records only
// while the Trace panel records (`on`).

import { injectable } from '@theia/core/shared/inversify';
import { TraceSpan, TraceStat } from '@catenary/model';
import { VisibleUpdateTrace } from './visible-update-trace';

/** Calls that the trace does not measure: the trace itself and the RPC plumbing. */
const UNTRACED = new Set(['setClient', 'getClient', 'dispose', 'setTracing', 'trace', 'clearTrace', 'then']);

@injectable()
export class FrontendTrace {
    private recording = false;
    private readonly visible = new VisibleUpdateTrace((name, start, ms) => this.record(name, start, ms, 0, false, 'paint'));
    generation = 0;
    get on(): boolean { return this.recording; }
    set on(value: boolean) {
        if (value === this.recording) return;
        this.recording = value;
        this.generation++;
        if (typeof document !== 'undefined') {
            if (value) this.visible.start();
            else this.visible.stop();
        }
    }
    /** Negative ids: they do not collide with the ids of the backend. */
    protected nextId = 0;
    protected fresh: TraceSpan[] = [];
    protected readonly totals = new Map<string, TraceStat>();

    record(name: string, start: number, ms: number, size: number, error: boolean, kind: 'roundtrip' | 'paint' = 'roundtrip'): void {
        if (!this.on) return;
        ms = Math.round(ms * 1000) / 1000;
        const span: TraceSpan = { id: -++this.nextId, kind, name, start, ms, size };
        if (error) span.error = true;
        this.fresh.push(span);
        if (this.fresh.length > 3000) this.fresh = this.fresh.slice(-2000);
        const key = `${kind} ${name}`;
        let stat = this.totals.get(key);
        if (!stat) this.totals.set(key, stat = { kind, name, calls: 0, totalMs: 0, maxMs: 0, size: 0, last: start });
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
        this.generation++;
        if (typeof document !== 'undefined') this.visible.cancel();
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
                    const start = Date.now(), t0 = performance.now(), generation = trace.generation;
                    return Promise.resolve(call.apply(target, args)).then(
                        r => { if (generation === trace.generation) trace.record(name, start, performance.now() - t0, sizeOf(r), false); return r; },
                        e => { if (generation === trace.generation) trace.record(name, start, performance.now() - t0, 0, true); throw e; });
                });
            }
            return fn;
        }
    });
}
