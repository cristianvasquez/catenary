import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelStore } from '../src/model-store';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';

// ADR 0003 step 5: a change on disk by another program is read into its graph.

const dirs: string[] = [], stores: ModelStore[] = [];
afterEach(async () => {
    for (const s of stores.splice(0)) { await s.dispose(); }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function workspace(watching = false) {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-watch-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    const ws = writeWorkspace(dir);
    const store = new ModelStore();
    store.watching = watching;
    stores.push(store);
    const r = await store.open(ws);
    if (!r.ok) throw new Error(r.error);
    const file = (name: string) => join(dir, name);
    return { dir, store, file, read: (name: string) => readFileSync(file(name), 'utf8') };
}
const ok = (r: { ok: boolean; error?: string }) => { if (!r.ok) throw new Error(r.error); };
/** Resolves when `ok()` is true. A stalled test fails after `ms` (monotonic clock), with the last observed state. */
async function until(ok: () => boolean, state: () => unknown, ms = 5000): Promise<void> {
    for (const end = performance.now() + ms; !ok(); await new Promise(r => setTimeout(r, 20))) {
        if (performance.now() > end) throw new Error(`timeout after ${ms} ms; last state: ${JSON.stringify(state())}`);
    }
}
/** Deliver the debounced paths of a watch to the store, as its watcher does. Resolves when the queued reconciliation is done. */
const deliver = (store: ModelStore, changed?: string[]) => store['reconciler'].settled(changed);
const labels = (store: ModelStore) => Object.values(docOf(store).instances).map(i => i.label);
const views = (store: ModelStore) => Object.values(docOf(store).views).map(v => v.label).sort();
const VIEW = (iri: string, label: string) => `<${iri}> { <${iri}> a <https://cristianvasquez.github.io/catenary/vocab/view#View> ; <http://www.w3.org/2000/01/rdf-schema#label> "${label}" . }\n`;

describe('changes on disk', () => {
    it('an edit of the data file by another program is read into the data graph; undo is cleared', async () => {
        const { store, file, read } = await workspace();
        ok(store.execute({ kind: 'rename', id: Object.values(docOf(store).instances).find(i => i.label === 'Product usage data')!.id, label: 'Mine' }));
        await store.idle();
        expect(store.canUndo).toBe(true);
        writeFileSync(file('data.ttl'), read('data.ttl').replace('"Mine"', '"Theirs"'));
        expect(await store.syncFromDisk()).toEqual(['data.ttl']);
        expect(labels(store)).toContain('Theirs');
        expect(labels(store)).not.toContain('Mine');
        expect(store.canUndo).toBe(false);
        expect(store.dirty).toBe(false);
    });

    it('an edit of a shapes file and of a view file is read into their graphs', async () => {
        const { store, file, read } = await workspace();
        const shape = Object.values(docOf(store).shapes.nodeShapes).find(s => s.label === 'Dataset')!;
        writeFileSync(file('shapes.ttl'), read('shapes.ttl').replace('sh:name "Dataset"', 'sh:name "Data set"'));
        writeFileSync(file('views/product-context.view.trig'), read('views/product-context.view.trig').replace('"Product context"', '"Context"'));
        expect((await store.syncFromDisk()).sort()).toEqual(['shapes.ttl', 'views/product-context.view.trig']);
        expect(docOf(store).shapes.nodeShapes[shape.id].label).toBe('Data set');
        expect(views(store)).toEqual(['Context']);
    });

    it('a new view file adds a view; a removed view file removes it', async () => {
        const { store, file } = await workspace();
        writeFileSync(file('views/idea.view.trig'), VIEW('urn:name:Idea', 'Idea'));
        expect(await store.syncFromDisk()).toEqual(['views/idea.view.trig']);
        expect(views(store)).toEqual(['Idea', 'Product context']);
        expect(store.files.views.find(v => v.path === file('views/idea.view.trig'))).toBeDefined();
        unlinkSync(file('views/idea.view.trig'));
        expect(await store.syncFromDisk()).toEqual(['views/idea.view.trig']);
        expect(views(store)).toEqual(['Product context']);
    });

    it('own writes are not read again; an edit after a change on disk keeps that change', async () => {
        const { store, file, read } = await workspace();
        const id = (label: string) => Object.values(docOf(store).instances).find(i => i.label === label)!.id;
        ok(store.execute({ kind: 'rename', id: id('Product usage data'), label: 'Mine' }));
        await store.idle();
        expect(await store.syncFromDisk()).toEqual([]);
        writeFileSync(file('data.ttl'), read('data.ttl') + '\n<urn:name:Extra> a <https://ekgf.github.io/dprod/DataProduct> ;\n    <http://www.w3.org/2000/01/rdf-schema#label> "Extra" .\n');
        expect(await store.syncFromDisk()).toEqual(['data.ttl']);
        ok(store.execute({ kind: 'rename', id: id('Mine'), label: 'Mine again' }));
        await store.idle();
        expect(store.warnings.filter(w => w.startsWith('Not '))).toEqual([]);
        expect(read('data.ttl')).toContain('"Extra"');
        expect(read('data.ttl')).toContain('"Mine again"');
    });

    it('a pending write and a change on disk: the disk wins, with a warning', async () => {
        const { store, file, read } = await workspace();
        const before = read('data.ttl');
        writeFileSync(file('data.ttl'), before + '\n# edited outside\n');
        ok(store.execute({ kind: 'rename', id: Object.values(docOf(store).instances).find(i => i.label === 'Product usage data')!.id, label: 'Lost' }));
        await store.idle();
        expect(store.dirty).toBe(true);
        expect(await store.syncFromDisk()).toEqual(['data.ttl']);
        expect(labels(store)).not.toContain('Lost');
        expect(store.dirty).toBe(false);
        expect(store.warnings.some(w => w.includes('data.ttl changed on disk') && w.includes('lost'))).toBe(true);
        expect(store.warnings.filter(w => w.startsWith('Not written'))).toEqual([]);
    });

    it('a change of the workspace file opens the workspace again', async () => {
        const { store, file, read } = await workspace();
        writeFileSync(file('workspace.trig'), read('workspace.trig') + '# edited by hand\n');
        expect(await store.syncFromDisk()).toEqual(['workspace.trig']);
        expect(store.warnings.some(w => w.includes('workspace.trig changed on disk'))).toBe(true);
    });

    it('a removed workspace folder: nothing is read or written, one warning; a new open works again', async () => {
        const { dir, store } = await workspace();
        const moved = dir + '-moved';
        renameSync(dir, moved);
        expect(await store.syncFromDisk()).toEqual([]);
        expect(Object.keys(docOf(store).views).length).toBeGreaterThan(0);
        expect(store.warnings.filter(w => w.includes('was removed or moved on disk'))).toHaveLength(1);
        renameSync(moved, dir);
        expect((await store.open(join(dir, 'workspace.trig'))).ok).toBe(true);
        expect(store.warnings.filter(w => w.includes('was removed or moved on disk'))).toEqual([]);
    });

    it('a file that cannot be read: removed on disk, its entry and its warning go', async () => {
        const { store, file } = await workspace();
        writeFileSync(file('broken.ttl'), '<urn:a> <urn:b> .\n');
        expect(await store.syncFromDisk()).toEqual([]);
        expect(store.files.files.find(f => f.path === file('broken.ttl'))?.error).toBeTruthy();
        expect(store.warnings.filter(w => w.startsWith('broken.ttl: not read: '))).toHaveLength(1);
        unlinkSync(file('broken.ttl'));
        expect(await store.syncFromDisk()).toEqual(['broken.ttl']);
        expect(store.files.files.map(f => f.path)).not.toContain(file('broken.ttl'));
        expect(store.warnings.filter(w => w.startsWith('broken.ttl'))).toEqual(['broken.ttl was removed on disk.']);
    });

    it('a file that cannot be read: repaired on disk, it is read and its warning goes', async () => {
        const { store, file } = await workspace();
        writeFileSync(file('broken.ttl'), '<urn:a> <urn:b> .\n');
        await store.syncFromDisk();
        writeFileSync(file('broken.ttl'), '<urn:a> <urn:b> <urn:c> .\n');
        expect(await store.syncFromDisk()).toEqual(['broken.ttl']);
        expect(store.files.files.find(f => f.path === file('broken.ttl'))?.error).toBeUndefined();
        expect(store.warnings.filter(w => w.startsWith('broken.ttl: not read: '))).toEqual([]);
    });

    it('the watcher reads a change without a call', async () => {
        const { store, file, read } = await workspace(true);
        writeFileSync(file('data.ttl'), read('data.ttl').replace('"Product usage data"', '"Seen by the watcher"'));
        await until(() => labels(store).includes('Seen by the watcher'), () => labels(store));
    });

    it('the watch events of own writes do not read the files again; a change by another program in the same burst does', async () => {
        const { store, file, read } = await workspace();
        const sync = vi.spyOn(store, 'syncFromDisk');
        const id = Object.values(docOf(store).instances).find(i => i.label === 'Product usage data')!.id;
        ok(store.execute({ kind: 'rename', id, label: 'Mine' }));
        await store.idle();
        expect(read('data.ttl')).toContain('"Mine"');
        await deliver(store, [file('data.ttl')]);
        expect(sync).not.toHaveBeenCalled();
        // The event queues after the write that caused it: the file holds the own write when the reconciliation reads it.
        ok(store.execute({ kind: 'rename', id, label: 'Mine again' }));
        const own = deliver(store, [file('data.ttl')]);
        writeFileSync(file('shapes.ttl'), read('shapes.ttl') + '\n');
        await own;
        expect(sync).not.toHaveBeenCalled();
        await deliver(store, [file('data.ttl'), file('shapes.ttl')]);
        expect(sync).toHaveBeenCalledTimes(1);
        expect(read('data.ttl')).toContain('"Mine again"');
        // An event without a name can be any file: read.
        await deliver(store, undefined);
        expect(sync).toHaveBeenCalledTimes(2);
    });

    it('a real watch: a change by another program after an own write is read', async () => {
        const { store, file, read } = await workspace(true);
        const sync = vi.spyOn(store, 'syncFromDisk');
        const id = Object.values(docOf(store).instances).find(i => i.label === 'Product usage data')!.id;
        ok(store.execute({ kind: 'rename', id, label: 'Mine' }));
        writeFileSync(file('shapes.ttl'), read('shapes.ttl').replace('sh:name "Dataset"', 'sh:name "Data set"'));
        const shapes = () => Object.values(docOf(store).shapes.nodeShapes).map(s => s.label);
        await until(() => shapes().includes('Data set'), () => ({ calls: sync.mock.calls.length, shapes: shapes() }));
        await store.idle();
        expect(sync).toHaveBeenCalled();
        expect(read('data.ttl')).toContain('"Mine"');
    });
});
