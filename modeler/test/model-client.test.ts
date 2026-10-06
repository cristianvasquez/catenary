import { describe, expect, it, vi } from 'vitest';
import { ModelSnapshot } from '@catenary/model';
import { ModelFrontend, ModelWatcher } from '../src/browser/model-client';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}
const snapshot = (revision: number, shapesVersion = 0): ModelSnapshot => ({
    revision, shapesVersion, file: '/workspace.trig', files: { files: [], views: [] }, meta: { classes: [] },
    counts: { instances: 0, results: 0, violations: 0 }, warnings: [], migrations: [], movedIds: {}, prefixes: { table: {}, stored: false }, dirty: false, canUndo: false, canRedo: false
});

describe('frontend model notifications', () => {
    it('does not overwrite a pushed edit with a late startup snapshot or subscribe twice', async () => {
        const initial = deferred<ModelSnapshot>();
        const watcher = new ModelWatcher();
        const service = { getSnapshot: vi.fn(() => initial.promise), shapesText: vi.fn(async () => '') };
        const frontend = Object.assign(new ModelFrontend(), { watcher, service });
        const changed = vi.fn();
        frontend.onDidChange(changed);
        const start = frontend.start();
        expect(frontend.start()).toBe(start);
        watcher.onDidChange(snapshot(2));
        initial.resolve(snapshot(1));
        await start;
        expect(frontend.snapshot.revision).toBe(2);
        expect(service.getSnapshot).toHaveBeenCalledTimes(1);
        changed.mockClear();
        watcher.onDidChange(snapshot(3));
        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed.mock.calls[0][0]).toBe(frontend.snapshot);
    });

    it('does not publish stale shapes to the properties form after shapes are reloaded', async () => {
        const oldShapes = deferred<string>(), newShapes = deferred<string>();
        const watcher = new ModelWatcher();
        const service = {
            getSnapshot: async () => snapshot(1, 1),
            shapesText: vi.fn().mockReturnValueOnce(oldShapes.promise).mockReturnValueOnce(newShapes.promise)
        };
        const frontend = Object.assign(new ModelFrontend(), { watcher, service });
        await frontend.start();
        watcher.onDidChange(snapshot(2, 2));
        newShapes.resolve('new shapes');
        await newShapes.promise;
        expect(frontend.shapesText).toBe('new shapes');
        const changed = vi.fn();
        frontend.onDidChange(changed);
        oldShapes.resolve('old shapes');
        await oldShapes.promise;
        expect(frontend.shapesText).toBe('new shapes');
        expect(changed).not.toHaveBeenCalled();
        watcher.onDidChange(snapshot(3, 2));
        expect(service.shapesText).toHaveBeenCalledTimes(2);
    });
});
