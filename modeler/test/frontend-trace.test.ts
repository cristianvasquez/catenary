import { describe, expect, it } from 'vitest';
import { FrontendTrace, tracedService } from '../src/browser/trace/frontend-trace';

describe('frontend trace recording', () => {
    it('records requests only while enabled', async () => {
        const trace = new FrontendTrace();
        const service = tracedService({ read: async () => ({ value: 1 }) }, trace);
        await service.read();
        expect(trace.take()).toEqual([]);
        trace.on = true;
        await service.read();
        expect(trace.take()).toMatchObject([{ kind: 'roundtrip', name: 'read', size: 11 }]);
        trace.on = false;
    });
    it.each(['stop', 'clear'])('discards a request that finishes after %s', async action => {
        const trace = new FrontendTrace();
        let finish!: () => void;
        const service = tracedService({ read: () => new Promise<void>(resolve => { finish = resolve; }) }, trace);
        trace.on = true;
        const pending = service.read();
        if (action === 'stop') { trace.on = false; trace.on = true; }
        else trace.clear();
        finish();
        await pending;
        expect(trace.take()).toEqual([]);
        expect(trace.stats()).toEqual([]);
        trace.on = false;
    });
});
