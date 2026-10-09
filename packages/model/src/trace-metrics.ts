import { TraceSpan, TraceStat } from './trace';

/** Nearest-rank percentiles of retained samples. Empty means not measured. */
export function traceDistribution(samples: readonly number[]) {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : undefined;
    return { samples: sorted.length, p50: at(.5), p95: at(.95), max: sorted[sorted.length - 1] };
}

/** Use query totals once, not the inclusive durations of their parent spans. */
export function traceMetrics(stats: readonly TraceStat[], spans: readonly TraceSpan[], loopDelay: readonly number[] = []) {
    const sum = (filter: (s: TraceStat) => boolean, field: 'calls' | 'totalMs') => stats.filter(filter).reduce((n, s) => n + s[field], 0);
    return {
        visibleUpdate: traceDistribution(spans.filter(s => s.kind === 'paint').map(s => s.ms)),
        eventLoop: traceDistribution(loopDelay),
        rpcCount: sum(s => s.kind === 'rpc', 'calls'),
        queryMs: sum(s => s.kind === 'sparql' || s.kind === 'match', 'totalMs'),
        fullViewReads: sum(s => s.kind === 'refresh' && s.name === 'read full view', 'calls')
    };
}
