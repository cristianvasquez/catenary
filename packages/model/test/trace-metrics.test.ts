import { describe, expect, it } from 'vitest';
import { TraceSpan, TraceStat, traceDistribution, traceMetrics } from '../src';

const stat = (kind: TraceStat['kind'], name: string, calls: number, totalMs: number): TraceStat =>
    ({ kind, name, calls, totalMs, maxMs: totalMs, size: 0, last: 0 });

describe('trace performance metrics', () => {
    it('law_traceQueryTimeOnce: counts each query once, not inclusive parents', () => {
        const metrics = traceMetrics([
            stat('rpc', 'links', 2, 100), stat('sparql', 'select', 3, 12), stat('match', 'pattern', 9, 4),
            stat('refresh', 'read full view', 1, 30), stat('refresh', 'read selected view', 2, 10), stat('roundtrip', 'links', 2, 120)
        ], []);
        expect(metrics).toMatchObject({ rpcCount: 2, queryMs: 16, fullViewReads: 1 });
        expect(metrics.visibleUpdate).toEqual({ samples: 0, p50: undefined, p95: undefined, max: undefined });
    });
    it('uses nearest-rank percentiles without changing samples', () => {
        const samples = [20, 1, 4, 3, 2];
        expect(traceDistribution(samples)).toEqual({ samples: 5, p50: 3, p95: 20, max: 20 });
        expect(samples).toEqual([20, 1, 4, 3, 2]);
    });
    it('separates browser and backend distributions', () => {
        const spans: TraceSpan[] = [{ id: -1, kind: 'paint', name: 'pointerdown', start: 0, ms: 42 },
            { id: -2, kind: 'roundtrip', name: 'links', start: 0, ms: 500 }];
        const metrics = traceMetrics([], spans, [8]);
        expect(metrics.eventLoop).toEqual({ samples: 1, p50: 8, p95: 8, max: 8 });
        expect(metrics.visibleUpdate).toEqual({ samples: 1, p50: 42, p95: 42, max: 42 });
    });
});
