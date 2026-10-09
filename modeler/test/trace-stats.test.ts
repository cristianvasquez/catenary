import { describe, expect, it } from 'vitest';
import type { TraceStat } from '@catenary/model';
import { addStats, sessionStats } from '../src/browser/trace/trace-stats';

const stat = (name: string, calls: number, totalMs: number, size = 0): TraceStat => ({ kind: 'rpc', name, calls, totalMs, maxMs: totalMs, size, last: 0 });

describe('trace panel totals', () => {
    it('a session counts from the backend totals at its start; another connection kept the trace on in between', () => {
        // The first session saw 2 calls of a. While the panel was hidden, another connection recorded 3 more calls of a.
        const first = sessionStats([stat('a', 2, 20)], []);
        const start = [stat('a', 5, 50), stat('b', 1, 1)];
        const now = [stat('a', 6, 60), stat('b', 1, 1), stat('c', 1, 3)];
        const second = sessionStats(now, start);
        expect(second.map(s => [s.name, s.calls, s.totalMs])).toEqual([['a', 1, 10], ['c', 1, 3]]);
        expect(addStats(first, second).map(s => [s.name, s.calls, s.totalMs])).toEqual([['a', 3, 30], ['c', 1, 3]]);
    });

    it('a key with fewer calls than at the start was cleared in the backend: it counts from zero', () => {
        expect(sessionStats([stat('a', 1, 4, 7)], [stat('a', 9, 90)]).map(s => [s.calls, s.totalMs, s.size])).toEqual([[1, 4, 7]]);
    });
});
