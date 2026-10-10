import { afterEach, describe, expect, it } from 'vitest';
import { MODEL_QUERIES, traceMetrics } from '@catenary/model';
import { ModelServiceImpl } from '../src/node/model-service';
import { tracer } from '@catenary/rdf';

afterEach(() => { while (tracer.on) tracer.setClient(false); });

describe('ModelServiceImpl tracing', () => {
    const fixture = () => {
        const ok = () => ({ ok: true as const });
        const store = Object.fromEntries(['create', 'setPrefixes', 'setSettings', 'setImported', 'importFiles', 'dismissMigration', 'save', 'undo', 'redo'].map(name => [name, ok]));
        return Object.assign(new ModelServiceImpl(), { store: {
            ...store, properties: () => undefined,
            execute: () => tracer.span('command', 'createView', ok)
        } });
    };

    it('law_traceCountsRpcOnce: includes reads, edits, undo and settings without tracing plumbing', async () => {
        const service = fixture();
        await service.setTracing(true);
        await service.clearTrace();
        await service.properties('selected');
        await service.execute({ kind: 'createView', label: 'Traced' });
        await service.undo();
        await service.redo();
        await service.save();
        await service.setSettings({ validation: 'off' });
        await service.setPrefixes({ ex: 'urn:ex:' });
        await service.setImported('file.ttl', true);
        await service.importFiles([]);
        await service.create('/scratch/workspace.trig');
        await service.dismissMigration('migration');
        const batch = await service.trace(0);
        const rpcs = batch.spans.filter(s => s.kind === 'rpc');
        expect(rpcs.map(s => s.name)).toEqual(['properties', 'execute', 'undo', 'redo', 'save', 'setSettings', 'setPrefixes', 'setImported', 'importFiles', 'create', 'dismissMigration']);
        expect(traceMetrics(batch.stats, batch.spans).rpcCount).toBe(11);
        expect(batch.spans.find(s => s.kind === 'command')?.parent).toBe(rpcs.find(s => s.name === 'execute')?.id);
    });

    it('law_traceStopKeepsFinalBatch: returns unpolled work before the last connection clears it', async () => {
        const service = fixture();
        await service.setTracing(true);
        const before = await service.trace(0);
        await service.execute({ kind: 'createView', label: 'Last request' });
        const final = await service.stopTracing(before.seq);
        expect(final.spans.some(s => s.kind === 'rpc' && s.name === 'execute')).toBe(true);
        expect(traceMetrics(final.stats, final.spans).rpcCount).toBe(1);
        expect(tracer.on).toBe(false);
        expect((await service.trace(0)).spans).toEqual([]);
    });

    it('stopping one connection does not stop another connection', async () => {
        const first = fixture(), second = fixture();
        await first.setTracing(true);
        await second.setTracing(true);
        await first.save();
        await first.stopTracing(0);
        expect(tracer.on).toBe(true);
        const final = await second.stopTracing(0);
        expect(final.spans.some(s => s.kind === 'rpc' && s.name === 'save')).toBe(true);
        expect(tracer.on).toBe(false);
    });
});

describe('ModelServiceImpl read queries', () => {
    it('has a prototype method for each query, which calls the store method with the store as `this` and returns a promise', async () => {
        const store = {
            prefix: 'store',
            ...Object.fromEntries(Object.keys(MODEL_QUERIES).map(name => [name, function (this: { prefix: string }, ...args: unknown[]) {
                return `${this.prefix}.${name}(${args.join(',')})`;
            }]))
        };
        const service = Object.assign(new ModelServiceImpl(), { store });
        for (const name of Object.keys(MODEL_QUERIES) as (keyof typeof MODEL_QUERIES)[]) {
            expect(Object.hasOwn(ModelServiceImpl.prototype, name)).toBe(true);
            const call = (service[name] as (...a: unknown[]) => Promise<unknown>)('a', 1);
            expect(call).toBeInstanceOf(Promise);
            expect(await call).toBe(`store.${name}(a,1)`);
        }
    });
});
