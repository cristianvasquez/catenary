import { afterEach, expect, it, vi } from 'vitest';
import { afterRevision } from '../src/browser/diagram/after-revision';

afterEach(() => vi.useRealTimers());

/** A fake diagram: its root revision and the listeners of a root change. */
function diagram(revision: number) {
    const listeners = new Set<() => void>();
    return {
        current: () => revision,
        onChange: (l: () => void) => { listeners.add(l); return { dispose: () => listeners.delete(l) }; },
        update: (r: number) => { revision = r; for (const l of [...listeners]) l(); },
        listeners
    };
}

it('law_revealAfterShowUpdate: a reveal after a show waits until the client model has the revision of the show update', async () => {
    const d = diagram(4);
    let done = false;
    const wait = afterRevision(Promise.resolve(5), d.current, d.onChange).then(() => { done = true; });
    await Promise.resolve();
    d.update(4);
    await Promise.resolve();
    expect(done).toBe(false);
    d.update(5);
    await wait;
    expect(done).toBe(true);
    expect(d.listeners.size).toBe(0);
});

it('a show without an update (the model has the revision) resolves at once; a failed or lost answer ends the wait', async () => {
    const d = diagram(5);
    await afterRevision(Promise.resolve(5), d.current, d.onChange);
    await afterRevision(Promise.reject(new Error('closed')), d.current, d.onChange);
    vi.useFakeTimers();
    let done = false;
    void afterRevision(new Promise<number>(() => undefined), d.current, d.onChange, 2000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBe(true);
});
