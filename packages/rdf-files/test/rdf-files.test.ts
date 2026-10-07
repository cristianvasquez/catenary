import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    FolderWatcher, OxigraphStore, SerialQueue, canonical, commitFiles, diskChanges, gitChanges, globRegExp, listRdfFiles, parseRdf, rdf,
    readUnchanged, serializeRdf, writeAll, writeProblem
} from 'rdf-files';

const dirs: string[] = [];
const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'rdf-files-'));
    dirs.push(d);
    return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const EX = 'http://example.org/';

/** Resolves when `ok()` is true; fails after `ms`. */
async function until(ok: () => boolean, ms = 5000): Promise<void> {
    for (const end = Date.now() + ms; !ok(); await new Promise(r => setTimeout(r, 10))) if (Date.now() > end) throw new Error('timeout');
}

describe('formats', () => {
    it('reads and writes Turtle with the same content', async () => {
        const quads = await parseRdf(`@prefix ex: <${EX}> .\nex:b ex:p "2" .\nex:a ex:p "1" .\n`, '/x/a.ttl');
        const text = await serializeRdf(quads, '/x/a.ttl', { ex: EX });
        expect(text).toContain('ex:a');
        expect(canonical(await parseRdf(text, '/x/a.ttl'))).toBe(canonical(quads));
    });

    it('canonical without blank nodes is stable and removes duplicate quads', async () => {
        const quads = await parseRdf(`@prefix ex: <${EX}> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
            ex:b ex:p "tab\\tquote\\"back\\\\slash\\nline\\r\\b\\f\\u0001\\u007F é" , "fr"@fr , "2"^^xsd:integer , "s"^^xsd:string , ex:a .
            ex:a ex:q <http://example.org/with%20space> .`, '/x/a.ttl');
        const all = [...quads, ...quads.map(q => rdf.quad(q.subject, q.predicate, q.object, rdf.namedNode(EX + 'g')))];
        const text = canonical(all);
        expect(canonical([...all].reverse())).toBe(text);
        expect(canonical([...all, ...all.slice(0, 3)])).toBe(text);
        expect(text.split('\n').filter(Boolean)).toHaveLength(12);
    });

    it('does not write a format that it only reads', () => {
        expect(writeProblem('/x/a.ttl')).toBeUndefined();
        expect(writeProblem('/x/a.n3')).toMatch(/read only/);
        expect(writeProblem('/x/a.txt')).toMatch(/unknown RDF format/);
    });
});

describe('OxigraphStore', () => {
    it('matches and selects', () => {
        const s = new OxigraphStore([rdf.quad(rdf.namedNode(EX + 'a'), rdf.namedNode(EX + 'p'), rdf.literal('1'))]);
        expect(s.size).toBe(1);
        expect(s.match(rdf.namedNode(EX + 'a'))).toHaveLength(1);
        expect(s.select('SELECT ?o WHERE { ?s ?p ?o }').map(b => b.o.value)).toEqual(['1']);
    });
});

describe('listRdfFiles', () => {
    it('lists RDF files, without hidden, excluded and stopped folders', async () => {
        const root = tempDir();
        const put = (rel: string, text = '') => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
        put('a.ttl'); put('b.txt'); put('.hidden/c.ttl'); put('old.ttl.bak'); put('gen/d.ttl'); put('nested/stop.trig'); put('nested/e.ttl');
        put('plain.json', '{"a":1}'); put('ld.json', '{"@context":{}}');
        const files = await listRdfFiles(root, { exclude: ['gen/**'], check: async f => (f.endsWith('stop.trig') ? 'stop' : undefined) });
        expect(files.map(f => f.slice(root.length + 1))).toEqual(['a.ttl', 'ld.json']);
    });

    it('stop: no file of the folder and its subfolders, whatever the order of the entries', async () => {
        const root = tempDir();
        const put = (rel: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), ''); };
        put('a.ttl'); put('nested/aa/sub.ttl'); put('nested/m.stop.ttl'); put('nested/x.ttl'); put('nested/zz/sub.ttl');
        const check = async (f: string) => (f.endsWith('.stop.ttl') ? 'stop' as const : undefined);
        expect((await listRdfFiles(root, { check })).map(f => f.slice(root.length + 1))).toEqual(['a.ttl']);
    });

    it('stop in the root folder acts as skip; the check runs before the globs', async () => {
        const root = tempDir();
        for (const f of ['a.stop.ttl', 'b.ttl']) writeFileSync(join(root, f), '');
        mkdirSync(join(root, 'sub'));
        for (const f of ['c.stop.ttl', 'd.ttl']) writeFileSync(join(root, 'sub', f), '');
        // The glob excludes the stop file of `sub`; its check still stops the folder.
        const files = await listRdfFiles(root, { exclude: ['sub/c.stop.ttl'], check: async f => (f.endsWith('.stop.ttl') ? 'stop' : undefined) });
        expect(files.map(f => f.slice(root.length + 1))).toEqual(['b.ttl']);
    });

    it('lists hidden files and .bak files when the caller gives another skip rule', async () => {
        const root = tempDir();
        for (const f of ['.a.ttl', 'b.bak']) writeFileSync(join(root, f), '');
        const files = await listRdfFiles(root, { skip: () => false, extensions: ['.ttl', '.bak'] });
        expect(files.map(f => f.slice(root.length + 1))).toEqual(['.a.ttl', 'b.bak']);
    });

    it('matches globs on relative paths', () => {
        expect(globRegExp('gen/**').test('gen/a/b.ttl')).toBe(true);
        expect(globRegExp('*.ttl').test('a/b.ttl')).toBe(false);
        expect(globRegExp('**/*.ttl').test('a/b.ttl')).toBe(true);
    });
});

describe('file sync', () => {
    it('finds removed, changed and new files; an unwritten file is not a removal', async () => {
        const root = tempDir();
        const [a, b, c, d] = ['a.ttl', 'b.ttl', 'c.ttl', 'd.ttl'].map(f => join(root, f));
        writeFileSync(a, 'same');
        writeFileSync(b, 'changed');
        writeFileSync(d, 'new');
        const e = join(root, 'e.ttl'), u = join(root, 'u.ttl');
        // e: no text and not unwritten (a read that failed): its absence is a removal. u: not on disk yet: not a removal.
        const r = await diskChanges([{ path: a, text: 'same' }, { path: b, text: 'before' }, { path: c, text: 'gone' }, { path: e }, { path: u, unwritten: true }], [a, b, d]);
        expect(r).toEqual({ removed: [c, e], read: [{ path: b, known: true }, { path: d, known: false }] });
    });

    it('refuses to overwrite a file that another program changed', async () => {
        const file = join(tempDir(), 'a.ttl');
        expect(await readUnchanged(file, 'x')).toBeUndefined();
        writeFileSync(file, 'other');
        await expect(readUnchanged(file, 'mine')).rejects.toThrow(/changed on disk/);
        expect(await readUnchanged(file, 'other')).toBe('other');
    });

    it('writes all files, and leaves no temporary file', async () => {
        const root = tempDir();
        const renamed: string[] = [];
        const error = await writeAll([{ file: join(root, 'a.ttl'), text: 'A' }, { file: join(root, 'sub/b.ttl'), text: 'B' }], w => renamed.push(w.text));
        expect(error).toBeUndefined();
        expect(renamed).toEqual(['A', 'B']);
        expect(readFileSync(join(root, 'sub/b.ttl'), 'utf8')).toBe('B');
        expect(readdirSync(root)).toEqual(['a.ttl', 'sub']);
    });

    it('writes no file when one temporary file fails', async () => {
        const root = tempDir();
        writeFileSync(join(root, 'blocker'), '');
        const error = await writeAll([{ file: join(root, 'a.ttl'), text: 'A' }, { file: join(root, 'blocker/b.ttl'), text: 'B' }]);
        expect(error).toMatch(/^Cannot write: /);
        expect(readdirSync(root)).toEqual(['blocker']);
    });

    it('returns an error when a rename fails; the files renamed before stay written, no temporary file stays', async () => {
        const root = tempDir();
        mkdirSync(join(root, 'b.ttl')); // a folder where the second file goes: its rename fails
        writeFileSync(join(root, 'b.ttl', 'keep'), '');
        const renamed: string[] = [];
        const error = await writeAll([{ file: join(root, 'a.ttl'), text: 'A' }, { file: join(root, 'b.ttl'), text: 'B' }], w => renamed.push(w.text));
        expect(error).toMatch(/^Cannot write b\.ttl: /);
        expect(renamed).toEqual(['A']);
        expect(readdirSync(root).sort()).toEqual(['a.ttl', 'b.ttl']);
    });

    it('runs queued operations one at a time, also after a failure', async () => {
        const q = new SerialQueue(), log: string[] = [];
        const slow = q.run(async () => { await new Promise(r => setTimeout(r, 20)); log.push('slow'); });
        const failed = q.run(async () => { log.push('fail'); throw new Error('x'); });
        const fast = q.run(async () => { log.push('fast'); });
        await expect(failed).rejects.toThrow('x');
        await Promise.all([slow, fast, q.idle()]);
        expect(log).toEqual(['slow', 'fail', 'fast']);
    });

    it('calls back once after a burst of changes, not for hidden files', async () => {
        const root = tempDir();
        let calls = 0;
        const w = new FolderWatcher(() => calls++, { debounce: 50 });
        w.watch(root);
        try {
            writeFileSync(join(root, '.hidden'), 'x');
            await new Promise(r => setTimeout(r, 200));
            expect(calls).toBe(0);
            writeFileSync(join(root, 'a.ttl'), '1');
            writeFileSync(join(root, 'a.ttl'), '2');
            await until(() => calls > 0);
            await new Promise(r => setTimeout(r, 200));
            expect(calls).toBe(1);
        } finally {
            w.close();
        }
    });

    it('watches a folder that was missing at the first call, at the next call', async () => {
        const root = join(tempDir(), 'later');
        let calls = 0;
        const w = new FolderWatcher(() => calls++, { debounce: 20 });
        w.watch(root);
        expect(w.folder).toBeUndefined();
        mkdirSync(root);
        w.watch(root);
        try {
            expect(w.folder).toBe(root);
            writeFileSync(join(root, 'a.ttl'), '1');
            await until(() => calls > 0);
        } finally {
            w.close();
        }
    });
});

describe('git', () => {
    // Not the git configuration of the user (signing, hooks, templates): the module and the test run git with the same environment.
    const saved = { ...process.env };
    beforeAll(() => Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' }));
    afterAll(() => {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    const repo = () => {
        const root = tempDir();
        git(root, 'init', '-q');
        return root;
    };
    const names = (files: string[]) => files.map(f => basename(f)).sort();

    it('reports changed files and commits only the given files', async () => {
        const root = repo();
        writeFileSync(join(root, 'a.ttl'), 'a');
        writeFileSync(join(root, 'b.ttl'), 'b');
        const changes = await gitChanges(root);
        expect(changes.ok && names(changes.files)).toEqual(['a.ttl', 'b.ttl']);
        expect(await commitFiles([join(root, 'a.ttl')], 'test')).toBeUndefined();
        expect(git(root, 'status', '--porcelain').trim()).toBe('?? b.ttl');
    });

    it('gives both paths of a rename', async () => {
        const root = repo();
        writeFileSync(join(root, 'a.ttl'), 'a');
        git(root, 'add', '-A');
        git(root, 'commit', '-qm', 'init');
        git(root, 'mv', 'a.ttl', 'b.ttl');
        const changes = await gitChanges(root);
        expect(changes.ok && names(changes.files)).toEqual(['a.ttl', 'b.ttl']);
    });

    it('commits a removed file that git knows, and skips one that it does not know', async () => {
        const root = repo();
        writeFileSync(join(root, 'a.ttl'), 'a');
        git(root, 'add', '-A');
        git(root, 'commit', '-qm', 'init');
        rmSync(join(root, 'a.ttl'));
        expect(await commitFiles([join(root, 'a.ttl'), join(root, 'never.ttl')], 'remove')).toBeUndefined();
        expect(git(root, 'log', '--format=%s', '-1').trim()).toBe('remove');
        expect(git(root, 'ls-files').trim()).toBe('');
    });

    // Git gives the real path of the repository: on Windows the long name of a short 8.3 name (C:\Users\RUNNER~1), else the target of a
    // link. The paths of the caller and the commit must not depend on it.
    it('a folder reached through a link: paths in the spelling of the caller, and the commit works', async () => {
        const real = repo();
        const link = join(tempDir(), 'link');
        symlinkSync(real, link, 'junction');
        writeFileSync(join(link, 'a.ttl'), 'a');
        const changes = await gitChanges(link);
        expect(changes.ok && changes.files).toEqual([join(link, 'a.ttl')]);
        expect(await commitFiles([join(link, 'a.ttl')], 'linked')).toBeUndefined();
        expect(git(real, 'log', '--format=%s', '-1').trim()).toBe('linked');
    });

    it('says when a folder is not in a repository', async () => {
        const root = tempDir();
        process.env.GIT_CEILING_DIRECTORIES = join(root, '..');
        try {
            const r = await gitChanges(root);
            expect(!r.ok && r.repo).toBe(false);
        } finally {
            delete process.env.GIT_CEILING_DIRECTORIES;
        }
    });

});
