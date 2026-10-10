import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceBatch, TraceSpan, TraceStat, traceMetrics } from '@catenary/model';
import { TraceWidget } from '../src/browser/trace/trace-widget';
import { FrontendTrace } from '../src/browser/trace/frontend-trace';

vi.mock('@theia/core/lib/browser', () => ({ ReactWidget: class { isVisible = true; update() {} }, AbstractViewContribution: class {}, codicon: (name: string) => name }));
vi.mock('../src/browser/model-client', () => ({ ModelServiceProxy: Symbol('ModelServiceProxy') }));

const stat = (calls: number): TraceStat => ({ kind: 'rpc', name: 'properties', calls, totalMs: calls * 2, maxMs: 2, size: 0, last: 0 });
const batch = (calls: number): TraceBatch => ({ seq: calls, on: true, dropped: 0, stats: calls ? [stat(calls)] : [],
    spans: Array.from({ length: calls }, (_, i): TraceSpan => ({ id: i + 1, kind: 'rpc', name: 'properties', start: 0, ms: 2 })) });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

class TestTraceWidget extends TraceWidget {
    seed(calls = 0): void {
        this.recording = true;
        this.backendRecording = true;
        this.local.on = true;
        this.seq = calls;
        this.live = calls ? [stat(calls)] : [];
        this.spans = batch(calls).spans;
    }
    end(): Promise<void> { this.stop(); return this.stopping; }
    resume(): void { this.start(); }
    reset(): void { this.clear(); }
    read(): Promise<void> { return this.poll(); }
    metrics() { return traceMetrics([...this.kept, ...this.live], this.spans, this.loopDelay); }
    ids() { return this.spans.map(s => s.id); }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function fixture(stopTracing: () => Promise<TraceBatch>) {
    const service = { stopTracing: vi.fn(stopTracing), trace: vi.fn(async () => batch(0)), setTracing: vi.fn(async () => {}), clearTrace: vi.fn(async () => {}) };
    const widget = Object.assign(new TestTraceWidget(), { service, local: new FrontendTrace() });
    return { widget, service };
}

describe('Trace panel final batch', () => {
    it('law_traceStopKeepsFinalBatch: retains work completed after the last poll without double counting', async () => {
        const final = batch(2);
        final.spans = final.spans.slice(1);
        const { widget, service } = fixture(async () => final);
        widget.seed(1);
        await widget.end();
        expect(service.stopTracing).toHaveBeenCalledExactlyOnceWith(1);
        expect(widget.metrics().rpcCount).toBe(2);
        expect(widget.ids()).toEqual([1, 2]);
    });

    it('waits for the final batch before a new recording starts', async () => {
        const final = deferred<TraceBatch>();
        const { widget, service } = fixture(() => final.promise);
        widget.seed();
        const stopped = widget.end();
        widget.resume();
        await Promise.resolve();
        expect(service.trace).not.toHaveBeenCalled();
        final.resolve(batch(2));
        await stopped;
        await vi.waitFor(() => expect(service.setTracing).toHaveBeenCalledWith(true));
        expect(widget.metrics().rpcCount).toBe(2);
        await widget.end();
    });

    it('a rapid Pause, Resume, Pause drains one backend session only once', async () => {
        const final = deferred<TraceBatch>();
        const { widget, service } = fixture(() => final.promise);
        widget.seed(1);
        void widget.end();
        widget.resume();
        const stopped = widget.end();
        await Promise.resolve();
        final.resolve({ ...batch(2), spans: batch(2).spans.slice(1) });
        await stopped;
        expect(service.stopTracing).toHaveBeenCalledTimes(1);
        expect(service.setTracing).not.toHaveBeenCalled();
        expect(widget.metrics().rpcCount).toBe(2);
        expect(widget.ids()).toEqual([1, 2]);
    });

    it('Clear prevents a pending final batch from restoring removed measurements', async () => {
        const final = deferred<TraceBatch>();
        const { widget } = fixture(() => final.promise);
        widget.seed(1);
        const stopped = widget.end();
        widget.reset();
        final.resolve(batch(2));
        await stopped;
        expect(widget.metrics().rpcCount).toBe(0);
        expect(widget.ids()).toEqual([]);
    });

    it('discards an old poll that completes after the final batch', async () => {
        const poll = deferred<TraceBatch>();
        const { widget, service } = fixture(async () => batch(2));
        service.trace.mockImplementation(() => poll.promise);
        widget.seed();
        const reading = widget.read();
        await widget.end();
        poll.resolve(batch(1));
        await reading;
        expect(widget.metrics().rpcCount).toBe(2);
        expect(widget.ids()).toEqual([1, 2]);
    });
});
