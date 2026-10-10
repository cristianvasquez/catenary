import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NS } from '@catenary/model';
import { OxigraphStore } from 'rdf-files';
import { ModelGraph } from '../src/graph';
import { openWorkspace } from '../src/loader';
import { filesOfSubject, placeChanges } from '../src/placement';
import { readChanges } from '../src/reconciler';
import { Saver } from '../src/saver';
import { rdf } from '../src/terms';
import { TracedStore } from '../src/trace';

const EX = 'http://example.org/';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A folder with two data files and no workspace file, opened with the sync modules as ModelStore wires them (no ModelStore). */
async function open() {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-ws-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.ttl'), `@prefix ex: <${EX}> .\nex:a a ex:C .\n`);
    writeFileSync(join(dir, 'b.ttl'), `@prefix ex: <${EX}> .\nex:b a ex:D .\n`);
    const notes: string[] = [];
    const graph = new ModelGraph(new TracedStore(new OxigraphStore()));
    const r = await openWorkspace(graph, join(dir, 'workspace.trig'), true);
    if ('error' in r) throw new Error(r.error);
    const { settings, loader } = r, saver = new Saver(graph, settings, t => notes.push(t));
    const ws = { graph, settings, loader, saver, filesOfSubject: (t: Parameters<typeof filesOfSubject>[1]) => filesOfSubject(graph, t) };
    /** Add a statement to the model graph, as a command does. */
    const add = (s: string, p: string, o: string) => {
        const quad = rdf.quad(rdf.namedNode(EX + s), rdf.namedNode(p), rdf.namedNode(EX + o), ws.graph.model);
        const { patch } = ws.graph.transact(g => {
            g.add(quad.subject, quad.predicate, quad.object, quad.graph);
            placeChanges(g, ws.settings);
            return { ok: true };
        });
        ws.settings.track(patch);
    };
    return { dir, ws, add, notes };
}

describe('sync modules', () => {
    it('a new statement goes to the file of its subject; a new subject near its class; a save writes them', async () => {
        const { dir, ws, add } = await open();
        expect(ws.saver.dirty).toBe(false);
        add('b', EX + 'p', 'a');
        add('c', NS.rdf + 'type', 'D');
        expect(ws.filesOfSubject(rdf.namedNode(EX + 'b'))).toEqual([join(dir, 'b.ttl')]);
        expect(ws.filesOfSubject(rdf.namedNode(EX + 'c'))).toEqual([join(dir, 'b.ttl')]);
        expect(ws.saver.dirty).toBe(true);
        expect(await ws.saver.save()).toEqual({ ok: true });
        expect(ws.saver.dirty).toBe(false);
        expect(readFileSync(join(dir, 'b.ttl'), 'utf8')).toContain('ex:c');
        expect(readFileSync(join(dir, 'a.ttl'), 'utf8')).not.toContain('ex:c');
        expect(ws.saver.written.sort()).toEqual([join(dir, 'b.ttl')]);
    });

    it('new nested values follow their referring subject before placement commits', async () => {
        const { dir, ws } = await open();
        const n = (s: string) => rdf.namedNode(EX + s);
        const { patch, result } = ws.graph.transact(g => {
            g.add(n('nested'), n('value'), rdf.literal('child'));
            g.add(n('b'), n('detail'), n('nested'));
            placeChanges(g, ws.settings);
            return { ok: true };
        });
        expect(result.ok).toBe(true);
        ws.settings.track(patch);
        expect(ws.filesOfSubject(n('nested'))).toEqual([join(dir, 'b.ttl')]);
        expect(patch.every(c => !c.quad.graph.equals(ws.graph.model))).toBe(true);
    });

    it('reads a file that another program changed, and a new file', async () => {
        const { dir, ws } = await open();
        writeFileSync(join(dir, 'a.ttl'), `@prefix ex: <${EX}> .\nex:a a ex:C ; ex:p ex:b .\n`);
        writeFileSync(join(dir, 'c.ttl'), `@prefix ex: <${EX}> .\nex:z a ex:C .\n`);
        const r = await readChanges(ws.graph, ws.settings, ws.loader, ws.saver.savedState());
        expect(r.read).toEqual(['a.ttl', 'c.ttl']);
        expect(ws.filesOfSubject(rdf.namedNode(EX + 'z'))).toEqual([join(dir, 'c.ttl')]);
    });

    it('a retired workspace does not save', async () => {
        const { ws, add } = await open();
        add('b', EX + 'p', 'a');
        ws.settings.retired = true;
        expect(await ws.saver.save()).toEqual({ ok: false, error: 'Another workspace was opened during the save.' });
    });

    it('the coordinator has no direct file I/O', () => {
        const source = readFileSync(join(__dirname, '..', 'src', 'model-store.ts'), 'utf8');
        expect(source).not.toMatch(/from 'fs'|existsSync|readDisk|readText|commitFiles|FolderWatcher|fs\./);
    });

    it('no sync module imports another; all read the settings (ModelStore wires them)', () => {
        const modules = ['loader', 'reconciler', 'placement', 'saver', 'validation-data'];
        const src = join(__dirname, '..', 'src');
        expect(readdirSync(src)).toEqual(expect.arrayContaining([...modules, 'settings'].map(m => `${m}.ts`)));
        for (const m of [...modules, 'settings']) {
            const imports = [...readFileSync(join(src, `${m}.ts`), 'utf8').matchAll(/from '\.\/([\w-]+)'/g)].map(x => x[1]);
            expect(imports.filter(i => modules.includes(i)), m).toEqual([]);
        }
    });
});
