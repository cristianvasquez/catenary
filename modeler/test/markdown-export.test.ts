import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_RESOURCES, ExportView, viewSvgName } from '@catenary/model';
import { OWNERSHIP_FILE, PreparedExport, checkOf, prepareMarkdownExport, writeMarkdownExport } from '../src/node/markdown-export';

const VIEWS = new Map<string, ExportView>([
    ['urn:name:Main', { id: 'n-main', label: 'Main' }],
    ['urn:name:Model', { id: 'n-model', label: 'Model' }]
]);
const SVG = (iri: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>${iri}</title></svg>`;
const svgs = Object.fromEntries([...VIEWS.keys()].map(iri => [iri, SVG(iri)]));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A temporary folder with files (relative path → text). */
function tree(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'catenary-md-'));
    dirs.push(root);
    for (const [rel, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), text);
    }
    return root;
}
const read = (root: string, rel: string) => readFileSync(path.join(root, rel), 'utf8');
/** Every file under a folder, relative, sorted. */
function listing(root: string, at = ''): string[] {
    return readdirSync(path.join(root, at), { withFileTypes: true }).flatMap(e => {
        const rel = at ? `${at}/${e.name}` : e.name;
        return e.isDirectory() ? listing(root, rel) : [rel];
    }).sort();
}
async function prepared(source: string, dest: string, views = VIEWS): Promise<PreparedExport> {
    const p = await prepareMarkdownExport(source, dest, views);
    if ('error' in p) throw new Error(p.error);
    return p;
}
const svgPath = (iri: string) => `${EXPORT_RESOURCES}/${viewSvgName(iri)}`;

const ARCH = '# Architecture\n\nThe system separates storage from presentation.\n\n![](urn:name:Main)\n\n## Components\n\n![Model](urn:name:Model)\n\nSee [Data model](Data%20model.md).\n';

describe('Markdown export: files (spec/ui-manifest.hs §9)', () => {
    it('exports prose with two views in order, relative SVG links, subfolders with their structure', async () => {
        const out = tree({});
        const src = tree({ 'Architecture.md': ARCH, 'Data model.md': '# Data model\n\n![](urn:name:Main)\n', 'sub/deep/c.md': '![](urn:name:Model)' });
        const r = await writeMarkdownExport(await prepared(src, out), svgs);
        expect(r.ok).toBe(true);
        const arch = read(out, 'Architecture.md');
        expect(arch).toBe(ARCH.replace('![](urn:name:Main)', `![Main](${svgPath('urn:name:Main')})`).replace('![Model](urn:name:Model)', `![Model](${svgPath('urn:name:Model')})`));
        expect(arch.indexOf(svgPath('urn:name:Main'))).toBeLessThan(arch.indexOf(svgPath('urn:name:Model')));
        expect(read(out, 'sub/deep/c.md')).toBe(`![Model](../../${svgPath('urn:name:Model')})`);
        // Two documents embed Main: one SVG file.
        expect(listing(out)).toEqual(['Architecture.md', 'Data model.md', OWNERSHIP_FILE, svgPath('urn:name:Main'), svgPath('urn:name:Model'), 'sub/deep/c.md'].sort());
        expect(read(out, svgPath('urn:name:Main'))).toBe(SVG('urn:name:Main'));
    });

    it('stops before it writes when an embed names no view: the file, the line and the IRI', async () => {
        const out = tree({});
        const src = tree({ 'a.md': 'Intro\n\n![Old](urn:name:Gone)\n' });
        const p = await prepared(src, out);
        const check = checkOf(p);
        expect(check.ok).toBe(false);
        expect(check.unresolved).toEqual([{ file: 'a.md', line: 3, iri: 'urn:name:Gone' }]);
        const r = await writeMarkdownExport(p, svgs);
        expect(r.ok).toBe(false);
        expect(r.unresolved).toEqual([{ file: 'a.md', line: 3, iri: 'urn:name:Gone' }]);
        expect(listing(out)).toEqual([]);
    });

    it('a changed view IRI is unresolved; a changed label is not', async () => {
        const src = tree({ 'a.md': '![Main](urn:name:Main)' });
        const relabeled = new Map([['urn:name:Main', { id: 'n-main', label: 'Renamed' }]]);
        expect(checkOf(await prepared(src, tree({}), relabeled)).ok).toBe(true);
        const moved = new Map([['urn:name:Main2', { id: 'n-main2', label: 'Main' }]]);
        expect(checkOf(await prepared(src, tree({}), moved)).unresolved).toEqual([{ file: 'a.md', line: 1, iri: 'urn:name:Main' }]);
    });

    it('rejects a destination in the source folder, also through a link, and a destination that is a file', async () => {
        const src = tree({ 'a.md': 'x', 'f.txt': 'x' });
        for (const dest of [src, path.join(src, 'out'), path.join(src, 'x', 'y')]) {
            expect(await prepareMarkdownExport(src, dest, VIEWS)).toEqual({ error: expect.stringMatching(/in the source folder/) });
        }
        const elsewhere = tree({});
        symlinkSync(src, path.join(elsewhere, 'link'));
        expect(await prepareMarkdownExport(src, path.join(elsewhere, 'link', 'out'), VIEWS)).toEqual({ error: expect.stringMatching(/in the source folder/) });
        expect(await prepareMarkdownExport(src, path.join(src, 'f.txt'), VIEWS)).toEqual({ error: expect.stringMatching(/in the source folder/) });
        expect(await prepareMarkdownExport(src, path.join(elsewhere, 'nope.txt'), VIEWS)).not.toHaveProperty('error');
        writeFileSync(path.join(elsewhere, 'file.txt'), 'x');
        expect(await prepareMarkdownExport(src, path.join(elsewhere, 'file.txt'), VIEWS)).toEqual({ error: expect.stringMatching(/not a folder/) });
    });

    it('copies local files: in the folder at their path, outside it to _resources; reports missing targets; links stay usable', async () => {
        const outside = tree({ 'logo.png': 'LOGO' });
        const src = tree({
            'docs/a.md': '',
            'docs/img/pic 1.png': 'PIC', 'b.md': '# B', '.hidden/h.md': 'not exported'
        });
        // The link to the outside file: relative from docs/ to the temporary folder of `outside`.
        const rel = path.relative(path.join(src, 'docs'), path.join(outside, 'logo.png')).split(path.sep).join('/');
        writeFileSync(path.join(src, 'docs/a.md'), `![i](img/pic%201.png) ![l](${rel}) [b](../b.md#part) ![g](gone.png) [h](https://example.org) [x](../.hidden/h.md)`);
        const out = tree({});
        const p = await prepared(src, out);
        expect(p.plan.problems.map(x => [x.target, x.message.split('.')[0]])).toEqual([['gone.png', 'The target does not exist'], ['../.hidden/h.md', 'The document is in a hidden folder']]);
        const r = await writeMarkdownExport(p, svgs);
        expect(r.ok).toBe(true);
        expect(read(out, 'docs/img/pic 1.png')).toBe('PIC');
        const text = read(out, 'docs/a.md');
        const copy = /!\[l\]\(([^)]+)\)/.exec(text)![1];
        expect(copy).toMatch(/^\.\.\/_resources\/logo-[0-9a-f]{12}\.png$/);
        expect(read(path.join(out, 'docs'), copy)).toBe('LOGO');
        expect(text).toContain('[b](../b.md#part)');
        expect(existsSync(path.join(out, '.hidden'))).toBe(false);
    });

    it('law_unownedNeverOverwritten: never overwrites a file that an export did not write; writes nothing then', async () => {
        const src = tree({ 'a.md': 'new', 'b.md': 'b' });
        const out = tree({ 'a.md': 'mine', 'notes.txt': 'unrelated' });
        const r = await writeMarkdownExport(await prepared(src, out), svgs);
        expect(r.ok).toBe(false);
        expect(r.conflicts).toEqual(['a.md: the file exists and an export did not write it.']);
        expect(listing(out)).toEqual(['a.md', 'notes.txt']);
        expect(read(out, 'a.md')).toBe('mine');
    });

    it('exports again after a change: updates its files, removes its old files, keeps unrelated and changed files', async () => {
        const src = tree({ 'a.md': '![](urn:name:Main)', 'b.md': 'b', 'c.md': 'c' });
        const out = tree({ 'notes.txt': 'unrelated' });
        expect((await writeMarkdownExport(await prepared(src, out), svgs)).ok).toBe(true);
        // Source changes: a.md embeds another view, b.md is gone, c.md is gone but its copy was edited by hand.
        writeFileSync(path.join(src, 'a.md'), '![](urn:name:Model)');
        rmSync(path.join(src, 'b.md'));
        rmSync(path.join(src, 'c.md'));
        writeFileSync(path.join(out, 'c.md'), 'edited');
        const r = await writeMarkdownExport(await prepared(src, out), svgs);
        expect(r.ok).toBe(true);
        expect(r.written.sort()).toEqual(['a.md', svgPath('urn:name:Model')].sort());
        expect(r.removed.sort()).toEqual(['b.md', svgPath('urn:name:Main')].sort());
        expect(r.kept).toEqual(['c.md']);
        expect(listing(out)).toEqual(['a.md', 'c.md', 'notes.txt', OWNERSHIP_FILE, svgPath('urn:name:Model')].sort());
        expect(read(out, 'c.md')).toBe('edited');
        // The edited file is no longer recorded: a third export does not remove it.
        expect(JSON.parse(read(out, OWNERSHIP_FILE)).files).not.toHaveProperty('c.md');
        const again = await writeMarkdownExport(await prepared(src, out), svgs);
        expect(again).toMatchObject({ ok: true, written: [], removed: [], kept: [] });
        expect(again.unchanged.sort()).toEqual(['a.md', svgPath('urn:name:Model')].sort());
    });

    it('a changed copy of an earlier export is not overwritten', async () => {
        const src = tree({ 'a.md': 'one' });
        const out = tree({});
        expect((await writeMarkdownExport(await prepared(src, out), svgs)).ok).toBe(true);
        writeFileSync(path.join(out, 'a.md'), 'edited');
        writeFileSync(path.join(src, 'a.md'), 'two');
        const r = await writeMarkdownExport(await prepared(src, out), svgs);
        expect(r.conflicts).toEqual(['a.md: the file changed after the last export.']);
        expect(read(out, 'a.md')).toBe('edited');
    });

    it('does not write through a link in the destination', async () => {
        const src = tree({ 'sub/a.md': 'x' });
        const out = tree({});
        const elsewhere = tree({});
        symlinkSync(elsewhere, path.join(out, 'sub'));
        const r = await writeMarkdownExport(await prepared(src, out), svgs);
        expect(r.conflicts).toEqual(['sub/a.md: a folder on the path leads out of the destination folder.']);
        expect(listing(elsewhere)).toEqual([]);
    });

    it('ignores recorded paths that leave the destination', async () => {
        const src = tree({ 'a.md': 'x' });
        const out = tree({});
        const victim = tree({ 'keep.md': 'x' });
        const rel = path.relative(out, path.join(victim, 'keep.md')).split(path.sep).join('/');
        mkdirSync(path.join(out, EXPORT_RESOURCES));
        writeFileSync(path.join(out, OWNERSHIP_FILE), JSON.stringify({ files: { [rel]: 'x' } }));
        expect((await writeMarkdownExport(await prepared(src, out), svgs)).ok).toBe(true);
        expect(read(victim, 'keep.md')).toBe('x');
    });

    it('a failed write reports the files written before it', async () => {
        const src = tree({ 'a.md': 'a', 'b/c.md': 'c' });
        const out = tree({ 'b': 'a file where a folder must be' });
        const r = await writeMarkdownExport(await prepared(src, out), svgs);
        expect(r.ok).toBe(false);
        expect(r.written).toEqual(['a.md']);
        expect(r.failed?.path).toBe('b/c.md');
        expect(r.error).toMatch(/1 file was written before it/);
        expect(statSync(path.join(out, 'b')).isFile()).toBe(true);
        expect(JSON.parse(read(out, OWNERSHIP_FILE)).files).toHaveProperty('a.md');
    });

    it('leaves the source folder unchanged', async () => {
        const src = tree({ 'a.md': ARCH, 'img/x.png': 'X' });
        writeFileSync(path.join(src, 'Data model.md'), 'd');
        const before = listing(src).map(f => [f, read(src, f)]);
        expect((await writeMarkdownExport(await prepared(src, tree({})), svgs)).ok).toBe(true);
        expect(listing(src).map(f => [f, read(src, f)])).toEqual(before);
    });
});
