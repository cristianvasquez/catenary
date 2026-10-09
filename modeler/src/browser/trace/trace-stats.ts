// Totals of the Trace panel. The backend totals are shared by all connections that trace and grow while one of them records, so a panel
// shows its own sessions: the backend totals minus the totals at the start of the session, added over the sessions.

import { TraceStat } from '@catenary/model';

export const statKey = (s: Pick<TraceStat, 'kind' | 'name'>) => `${s.kind} ${s.name}`;

/** The totals of `a` and `b` added by key. */
export function addStats(a: TraceStat[], b: TraceStat[]): TraceStat[] {
    const sum = new Map(a.map(s => [statKey(s), { ...s }]));
    for (const s of b) {
        const t = sum.get(statKey(s));
        if (!t) { sum.set(statKey(s), { ...s }); continue; }
        t.calls += s.calls;
        t.totalMs += s.totalMs;
        t.maxMs = Math.max(t.maxMs, s.maxMs);
        t.size += s.size;
        t.last = Math.max(t.last, s.last);
    }
    return [...sum.values()];
}

/**
 * The totals of a session: `now` minus `start` (the backend totals at the start of the session), by key. A key with fewer calls than at
 * the start was cleared in the backend after the start: its totals count from zero. `maxMs` is the backend maximum: it can be older
 * than the session.
 */
export function sessionStats(now: TraceStat[], start: TraceStat[]): TraceStat[] {
    const before = new Map(start.map(s => [statKey(s), s]));
    const out: TraceStat[] = [];
    for (const s of now) {
        const b = before.get(statKey(s));
        if (!b || s.calls < b.calls) { out.push({ ...s }); continue; }
        if (s.calls === b.calls) continue;
        out.push({ ...s, calls: s.calls - b.calls, totalMs: s.totalMs - b.totalMs, size: s.size - b.size });
    }
    return out;
}
