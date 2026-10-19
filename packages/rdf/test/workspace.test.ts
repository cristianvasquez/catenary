import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_QUERIES, NS } from '@catenary/model';
import { OxigraphStore } from 'rdf-files';
import { openWorkspace } from '../src/loader';
import { filesOfSubject, placeChanges } from '../src/placement';
import { readChanges } from '../src/reconciler';
import { Saver } from '../src/saver';
import { rdf } from '../src/terms';
import { TracedStore } from '../src/trace';
import { newModelGraph } from '../src/model-graph';
import { DATA, SHAPES, openStore, tempWorkspace, writeWorkspace } from './helpers';

const EX = 'http://example.org/';

/** A folder with two data files and no workspace file, opened with the sync modules as ModelStore wires them (no ModelStore). */
async function open() {
    const { dir } = tempWorkspace({ 'a.ttl': `@prefix ex: <${EX}> .\nex:a a ex:C .\n`, 'b.ttl': `@prefix ex: <${EX}> .\nex:b a ex:D .\n` }, 'catenary-ws-');
    const notes: string[] = [];
    const graph = newModelGraph(new TracedStore(new OxigraphStore()));
    const r = await openWorkspace(graph, join(dir, 'workspace.trig'), true);
    if ('error' in r) throw new Error(r.error);
    const { settings, loader } = r, saver = new Saver(graph, settings, t => notes.push(t));
    const ws = { graph, settings, loader, saver, filesOfSubject: (t: Parameters<typeof filesOfSubject>[1]) => filesOfSubject(graph, t) };
    /** Add a statement to the model graph, as a command does. */
    const add = (s: string, p: string, o: string) => {
        const quad = rdf.quad(rdf.namedNode(EX + s), rdf.namedNode(p), rdf.namedNode(EX + o), ws.graph.union);
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
            g.add(n('nested'), n('value'), rdf.literal('child'), g.union);
            g.add(n('b'), n('detail'), n('nested'), g.union);
            placeChanges(g, ws.settings);
            return { ok: true };
        });
        expect(result.ok).toBe(true);
        ws.settings.track(patch);
        expect(ws.filesOfSubject(n('nested'))).toEqual([join(dir, 'b.ttl')]);
        expect(patch.every(c => !c.quad.graph.equals(ws.graph.union))).toBe(true);
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

    it('PanelReads implements every frontend query; the coordinator has no delegations or SPARQL text', () => {
        const src = join(__dirname, '..', 'src');
        const source = readFileSync(join(src, 'model-store.ts'), 'utf8');
        const reads = readFileSync(join(src, 'panel-reads.ts'), 'utf8');
        expect(source).not.toMatch(/SELECT|CONSTRUCT|ASK|GRAPH |FILTER|WHERE \{|this\.reads\./);
        for (const name of Object.keys(MODEL_QUERIES)) {
            expect(source, name).not.toMatch(new RegExp(`^    (?:async )?${name}\\(`, 'm'));
            expect(reads, name).toMatch(new RegExp(`^    (?:async )?${name}\\(`, 'm'));
        }
    });

    it('no sync module imports another; all read the settings (ModelStore wires them)', () => {
        const modules = ['loader', 'reconciler', 'placement', 'saver', 'validation-data', 'import'];
        const src = join(__dirname, '..', 'src');
        expect(readdirSync(src)).toEqual(expect.arrayContaining([...modules, 'settings'].map(m => `${m}.ts`)));
        for (const m of [...modules, 'settings']) {
            const imports = [...readFileSync(join(src, `${m}.ts`), 'utf8').matchAll(/from '\.\/([\w-]+)'/g)].map(x => x[1]);
            expect(imports.filter(i => modules.includes(i)), m).toEqual([]);
        }
    });
});

describe('a no-op and Git (manifest §5.1 law_noopLeavesHistory)', () => {
    it('a no-op makes no commit', async () => {
        const ws = tempWorkspace({ 'shapes.ttl': SHAPES, 'data.ttl': DATA }, 'catenary-noop-');
        let store = await openStore(writeWorkspace(ws.dir));
        expect((await store.setSettings({ autoCommit: true })).ok).toBe(true);
        await store.idle();
        const git = (...args: string[]) => execFileSync('git', args, { cwd: ws.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        git('init', '-q');
        git('config', 'user.name', 'Test');
        git('config', 'user.email', 'test@example.org');
        git('add', '-A');
        git('commit', '-q', '-m', 'start');
        store = await openStore(ws.path('workspace.trig'));
        expect(store.execute({ kind: 'delete', ids: ['urn:name:Nothing%20here'] })).toMatchObject({ ok: true, changed: false });
        await store.idle();
        expect(git('rev-list', '--count', 'HEAD')).toBe('1');
        expect(git('status', '--porcelain')).toBe('');
    });
});
