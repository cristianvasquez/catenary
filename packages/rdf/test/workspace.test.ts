import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NS } from '@catenary/model';
import { rdf } from '../src/terms';
import { Workspace } from '../src/workspace';

const EX = 'http://example.org/';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A folder with two data files and no workspace file, opened as a Workspace (no ModelStore). */
async function open() {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-ws-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'a.ttl'), `@prefix ex: <${EX}> .\nex:a a ex:C .\n`);
    writeFileSync(join(dir, 'b.ttl'), `@prefix ex: <${EX}> .\nex:b a ex:D .\n`);
    let content = 0;
    const notes: string[] = [];
    const r = await Workspace.open(join(dir, 'workspace.trig'), true, { content: () => content, note: t => notes.push(t) });
    if ('error' in r) throw new Error(r.error);
    const ws = r.workspace;
    /** Add a statement to the model graph, as a command does. */
    const add = (s: string, p: string, o: string) => {
        const quad = rdf.quad(rdf.namedNode(EX + s), rdf.namedNode(p), rdf.namedNode(EX + o), ws.graph.model);
        ws.graph.store.add(quad);
        ws.track([{ op: 'add', quad }]);
        content++;
    };
    return { dir, ws, add, notes };
}

describe('Workspace', () => {
    it('a new statement goes to the file of its subject; a new subject near its class; a save writes them', async () => {
        const { dir, ws, add } = await open();
        expect(ws.dirty).toBe(false);
        add('b', EX + 'p', 'a');
        add('c', NS.rdf + 'type', 'D');
        expect(ws.filesOfSubject(rdf.namedNode(EX + 'b'))).toEqual([join(dir, 'b.ttl')]);
        expect(ws.filesOfSubject(rdf.namedNode(EX + 'c'))).toEqual([join(dir, 'b.ttl')]);
        expect(ws.dirty).toBe(true);
        expect(await ws.save()).toEqual({ ok: true });
        expect(ws.dirty).toBe(false);
        expect(readFileSync(join(dir, 'b.ttl'), 'utf8')).toContain('ex:c');
        expect(readFileSync(join(dir, 'a.ttl'), 'utf8')).not.toContain('ex:c');
        expect(ws.written.sort()).toEqual([join(dir, 'b.ttl')]);
    });

    it('reads a file that another program changed, and a new file', async () => {
        const { dir, ws } = await open();
        writeFileSync(join(dir, 'a.ttl'), `@prefix ex: <${EX}> .\nex:a a ex:C ; ex:p ex:b .\n`);
        writeFileSync(join(dir, 'c.ttl'), `@prefix ex: <${EX}> .\nex:z a ex:C .\n`);
        const r = await ws.readChanges();
        expect(r.read).toEqual(['a.ttl', 'c.ttl']);
        expect(ws.filesOfSubject(rdf.namedNode(EX + 'z'))).toEqual([join(dir, 'c.ttl')]);
    });

    it('a retired workspace does not save', async () => {
        const { ws, add } = await open();
        add('b', EX + 'p', 'a');
        ws.retired = true;
        expect(await ws.save()).toEqual({ ok: false, error: 'Another workspace was opened during the save.' });
    });
});
