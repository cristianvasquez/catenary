import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelStore } from '../src/model-store';
import { parseRdf } from '../src/files';
import { rdf } from '../src/terms';
import * as patcher from 'rdf-files';
import { boxes } from '@catenary/model';
import { docOf } from './helpers';

const dirs: string[] = [], stores: ModelStore[] = [];
const data = '<urn:a> a <urn:Class> ; <http://www.w3.org/2000/01/rdf-schema#label> "Before" .\n';
function fixture(files: Record<string, string> = { 'data.ttl': data }, setting = '') {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-review-'));
    dirs.push(dir);
    const put = (file: string, text: string) => writeFileSync(join(dir, file), text);
    put('workspace.trig', `<urn:name:workspace> { <urn:name:workspace> a <https://cristianvasquez.github.io/catenary/vocab/workspace#Workspace> ${setting} . }\n`);
    for (const [file, text] of Object.entries(files)) put(file, text);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { dir, put, git, read: (file: string) => readFileSync(join(dir, file), 'utf8'), async open() {
        const store = new ModelStore();
        store.watching = false;
        stores.push(store);
        expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
        return store;
    }, init() {
        git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.org');
        git('add', '-A'); git('commit', '-qm', 'initial');
    } };
}
afterEach(async () => {
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) { await store.idle(); store.close(); }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function rename(store: ModelStore, label = 'After') {
    const id = Object.values(docOf(store).instances).find(i => i.uri === 'urn:a')!.id;
    expect(store.execute({ kind: 'rename', id, label }).ok).toBe(true);
    await store.idle();
    expect(store.dirty).toBe(false);
}

it('plain JSON is not a model file; the implicit default prefers nonempty Turtle', async () => {
    const config = '{"port":3917}\n';
    const f = fixture({ 'app-config.json': config, 'aaa.ttl': '', 'bbb.nt': data.replace(' a ', ' <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ').replace(' ; ', ' .\n<urn:a> '), 'data.ttl': data,
        'linked.json': '{"@context":{"p":"urn:p"},"@id":"urn:j","p":"value"}' });
    const store = await f.open();
    expect(store.files.files.map(x => x.path)).not.toContain(join(f.dir, 'app-config.json'));
    expect(store.files.files.map(x => x.path)).toContain(join(f.dir, 'linked.json'));
    expect(store.defaultFile).toBe(join(f.dir, 'data.ttl'));
    expect(store.execute({ kind: 'createInstance', classIri: 'urn:Other', label: 'New' }).ok).toBe(true);
    await store.idle();
    expect(f.read('app-config.json')).toBe(config);
});

it('an empty Turtle cannot displace a nonempty writable file', async () => {
    const f = fixture({ 'aaa.ttl': '', 'data.jsonld': '{"@context":{"p":"urn:p"},"@id":"urn:j","p":"value"}' });
    expect((await f.open()).defaultFile).toBe(join(f.dir, 'data.jsonld'));
});

it('a file with blank nodes: the first save writes their IRIs; then an edit changes one line only', async () => {
    const text = '# keep this comment\n@prefix ex: <urn:> .\nex:b ex:p _:x .\nex:c ex:p _:x .\n_:x ex:value "shared" .\n' + data;
    const f = fixture({ 'data.ttl': text });
    const store = await f.open();
    await rename(store);
    const written = f.read('data.ttl');
    expect(written).not.toContain('_:');
    expect(written).toContain('urn:skolem:');
    await rename(store, 'Again');
    expect(f.read('data.ttl')).toBe(written.replace('"After"', '"Again"'));
});

it('parse errors in a patch use the whole-file fallback and warn the user', async () => {
    const f = fixture();
    const store = await f.open();
    const original = patcher.patchTurtle;
    vi.spyOn(patcher, 'patchTurtle').mockImplementation(async (...args) => args[2].length
        ? { ok: true, text: 'undefined:subject undefined:predicate 1 .', inline: new Set() } : original(...args));
    await rename(store);
    expect(store.warnings.some(w => w.includes('written as a whole'))).toBe(true);
    expect((await parseRdf(f.read('data.ttl'), join(f.dir, 'data.ttl'))).some(q => q.object.value === 'After')).toBe(true);
    await rename(store, 'Again');
});

it('triplify fallback warns the user', async () => {
    const f = fixture();
    const store = await f.open();
    vi.spyOn(patcher, 'patchTurtle').mockResolvedValue({ ok: false, reason: 'test refusal' });
    await rename(store);
    expect(store.warnings.some(w => w.includes('written by triplify'))).toBe(true);
});

it.each(['', '; <https://cristianvasquez.github.io/catenary/vocab/workspace#defaultFile> "profile.n3"'])('read-only defaults and near placement use a writable file (%s)', async setting => {
    const f = fixture({ 'profile.n3': '<urn:a> a <urn:Class> .\n' }, setting);
    const store = await f.open();
    expect(store.defaultFile).toBe(join(f.dir, 'workspace.ttl'));
    await rename(store);
    expect(store.execute({ kind: 'createInstance', classIri: 'urn:Class', label: 'New' }).ok).toBe(true);
    await store.idle();
    expect(store.dirty).toBe(false);
    expect(f.read('profile.n3')).toBe('<urn:a> a <urn:Class> .\n');
    expect((await parseRdf(f.read('workspace.ttl'), join(f.dir, 'workspace.ttl'))).filter(q => q.predicate.equals(rdf.namedNode('http://www.w3.org/2000/01/rdf-schema#label')))).toHaveLength(2);
});

it.each(['open', 'reload'])('git preserves user changes present at %s and warns once', async when => {
    const f = fixture({ 'data file.ttl': data });
    f.init();
    const before = when === 'reload' ? await f.open() : undefined;
    f.put('data file.ttl', '# hand edit\n' + data);
    const store = before ?? await f.open();
    if (before) await store.syncFromDisk();
    await rename(store);
    await rename(store, 'Again');
    expect(f.git('log', '-1', '--format=%s')).toBe('initial');
    expect(f.read('data file.ttl')).toContain('"Again"');
    expect(store.warnings.filter(w => w.includes('not committed: data file.ttl has changes that are not committed'))).toHaveLength(1);
});

it('outside git gives one warning', async () => {
    const f = fixture();
    const store = await f.open();
    await rename(store);
    await rename(store, 'Again');
    expect(store.warnings.filter(w => w.includes('not a git repository'))).toHaveLength(1);
});

it('a failed commit keeps its paths for the next write', async () => {
    const f = fixture();
    f.init();
    const store = await f.open();
    f.put('.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    chmodSync(join(f.dir, '.git/hooks/pre-commit'), 0o755);
    await rename(store);
    expect(f.git('log', '-1', '--format=%s')).toBe('initial');
    rmSync(join(f.dir, '.git/hooks/pre-commit'));
    expect(await store.save()).toEqual({ ok: true });
    expect(f.git('status', '--porcelain')).toBe('');
    expect(f.git('show', 'HEAD:data.ttl')).toContain('"After"');
});

it('failed commit notes survive a reopen, but do not reach another coordinator', async () => {
    const f = fixture();
    f.init();
    const store = await f.open();
    f.put('.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    chmodSync(join(f.dir, '.git/hooks/pre-commit'), 0o755);
    await rename(store);
    const failure = store.warnings.find(w => w.startsWith('Not committed:'));
    expect(failure).toBeDefined();
    expect(await store.open(join(f.dir, 'workspace.trig'))).toEqual({ ok: true });
    const other = fixture();
    other.init();
    const second = await other.open();
    rmSync(join(f.dir, '.git/hooks/pre-commit'));
    expect(store.execute({ kind: 'createView', label: 'New' }).ok).toBe(true);
    await store.idle();
    expect(f.git('log', '-1', '--format=%s')).toBe('Catenary: rename, createView');
    expect(store.warnings).not.toContain(failure);
    expect(await second.save()).toEqual({ ok: true });
    expect(other.git('log', '-1', '--format=%s')).toBe('initial');
});

it('law_graphPatchKeepsText: a setBounds on a view file writes a text patch of the graph block (§10.2)', async () => {
    const f = fixture();
    const store = await f.open();
    expect(store.execute({ kind: 'createView', label: 'Cards' }).ok).toBe(true);
    const view = Object.values(docOf(store).views).find(v => v.label === 'Cards')!;
    const element = Object.values(docOf(store).instances).find(i => i.uri === 'urn:a')!.id;
    expect(store.execute({ kind: 'addToView', view: view.id, ids: [element], at: { x: 0, y: 0 } }).ok).toBe(true);
    await store.idle();
    const file = readdirSync(f.dir, { recursive: true, encoding: 'utf8' }).find(x => x.endsWith('.view.trig'))!;
    const written = f.read(file);
    const card = boxes(docOf(store).views[view.id], 'card')[0];
    const full = vi.spyOn(patcher, 'patchTurtle'), byDiff = vi.spyOn(patcher, 'patchTurtleDiff');
    expect(store.execute({ kind: 'setBounds', view: view.id, bounds: [{ id: card.id, x: card.x + 50, y: card.y + 50 }] }).ok).toBe(true);
    await store.idle();
    expect(store.dirty).toBe(false);
    // The write form: one patch call with the view graph and the changes since the last write (the two numbers), accepted (no whole-file note).
    expect(full).not.toHaveBeenCalled();
    expect(byDiff.mock.calls.map(c => [c[4]?.value, c[2].removed.length, c[2].added.length])).toEqual([[view.uri, 2, 2]]);
    expect(store.warnings.filter(w => w.includes('written as a whole'))).toEqual([]);
    // The text: the two numbers of the one placement change, the rest stays byte for byte.
    const after = f.read(file);
    const numbers = (text: string) => text.replace(/^(\s*view:(x|y)) -?\d+/gm, '$1 N');
    expect(numbers(after)).toBe(numbers(written));
    expect(after).not.toBe(written);
    const quads = await parseRdf(after, join(f.dir, file));
    expect(quads.every(q => q.graph.value === view.uri)).toBe(true);
    expect(quads.filter(q => q.predicate.value === 'https://cristianvasquez.github.io/catenary/vocab/view#x').map(q => q.object.value)).toEqual([String(card.x + 50)]);
});

it('law_graphPatchKeepsText: an edit during the disk read of a save does not break the next text patch', async () => {
    const VIEW = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix view: <https://cristianvasquez.github.io/catenary/vocab/view#>.
# keep this comment

<urn:name:Cards> {
  <urn:name:Cards> a view:View;
    rdfs:label "Cards".

  <urn:name:Cards/p/1> a view:Placement;
    view:element <urn:a>;
    view:view <urn:name:Cards>;
    view:x 0;
    view:y 0.

}
`;
    const f = fixture({ 'data.ttl': data + '<urn:b> a <urn:Class> ; <http://www.w3.org/2000/01/rdf-schema#label> "Second" .\n', 'cards.view.trig': VIEW });
    const store = await f.open();
    const view = Object.values(docOf(store).views).find(v => v.label === 'Cards')!;
    const cards = () => boxes(docOf(store).views[view.id], 'card');
    // The first write: from here on, the saver knows the changes of the view.
    expect(store.execute({ kind: 'setBounds', view: view.id, bounds: [{ id: cards()[0].id, x: 5, y: 5 }] }).ok).toBe(true);
    await store.idle();
    const written = f.read('cards.view.trig');
    expect(written).toBe(VIEW.replace('view:x 0;\n    view:y 0.', 'view:x 5;\n    view:y 5.'));
    // The next save pauses in its disk read; a new placement is moved meanwhile.
    const original = patcher.readUnchanged;
    let release!: () => void, reading!: () => void;
    const released = new Promise<void>(r => { release = r; }), read = new Promise<void>(r => { reading = r; });
    vi.spyOn(patcher, 'readUnchanged').mockImplementationOnce(async (...args) => { reading(); await released; return original(...args); });
    const byDiff = vi.spyOn(patcher, 'patchTurtleDiff');
    const second = Object.values(docOf(store).instances).find(i => i.uri === 'urn:b')!.id;
    expect(store.execute({ kind: 'addToView', view: view.id, ids: [second], at: { x: 100, y: 100 } }).ok).toBe(true);
    await read;
    const added = cards().find(c => c.element === second)!;
    expect(store.execute({ kind: 'setBounds', view: view.id, bounds: [{ id: added.id, x: 300, y: 300 }] }).ok).toBe(true);
    release();
    await store.idle();
    expect(store.dirty).toBe(false);
    // Both saves are text patches: the comment and the first block stay, the new block has the last coordinates.
    expect(byDiff).toHaveBeenCalledTimes(2);
    for (const r of byDiff.mock.results) expect(await r.value).toMatchObject({ ok: true });
    expect(store.warnings.filter(w => w.includes('written as a whole'))).toEqual([]);
    const text = f.read('cards.view.trig');
    expect(text.startsWith(written.slice(0, written.indexOf('\n}')))).toBe(true);
    const quads = await parseRdf(text, join(f.dir, 'cards.view.trig'));
    const placement = quads.find(q => q.predicate.value === 'https://cristianvasquez.github.io/catenary/vocab/view#element' && q.object.value === 'urn:b')!.subject;
    const of = (p: string) => quads.filter(q => q.subject.equals(placement) && q.predicate.value === 'https://cristianvasquez.github.io/catenary/vocab/view#' + p).map(q => q.object.value);
    expect([of('x'), of('y')]).toEqual([['300'], ['300']]);
});

it('near placement of new shapes skips read-only profiles', async () => {
    const f = fixture({ 'profile.n3': '<urn:Shape> a <http://www.w3.org/ns/shacl#NodeShape> ; <http://www.w3.org/ns/shacl#targetClass> <urn:Class> .\n' }, '; <https://cristianvasquez.github.io/catenary/vocab/workspace#placeShapes> "near"');
    const store = await f.open();
    expect(store.execute({ kind: 'createNodeShape', label: 'New shape' }).ok).toBe(true);
    await store.idle();
    expect(store.dirty).toBe(false);
    expect((await parseRdf(f.read('workspace.ttl'), join(f.dir, 'workspace.ttl'))).some(q => q.object.value === 'New shape')).toBe(true);
});


it('undo before the queued write restores saved content without a write or commit', async () => {
    const f = fixture();
    f.init();
    const store = await f.open();
    const write = vi.spyOn(patcher, 'writeAll');
    const id = Object.values(docOf(store).instances).find(i => i.uri === 'urn:a')!.id;
    expect(store.execute({ kind: 'rename', id, label: 'After' }).ok).toBe(true);
    expect(store.dirty).toBe(true);
    expect(store.undo().ok).toBe(true);
    expect(store.dirty).toBe(false);
    await store.idle();
    expect(write).not.toHaveBeenCalled();
    expect(f.read('data.ttl')).toBe(data);
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('1');
});

it('law_failedWriteStaysDirty: reversing a failed write restores saved content without retry or commit', async () => {
    const f = fixture();
    f.init();
    const store = await f.open();
    const write = vi.spyOn(patcher, 'writeAll').mockResolvedValueOnce('test write failure');
    const id = Object.values(docOf(store).instances).find(i => i.uri === 'urn:a')!.id;
    expect(store.execute({ kind: 'rename', id, label: 'After' }).ok).toBe(true);
    await store.idle();
    expect(store.dirty).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(store.undo().ok).toBe(true);
    expect(store.dirty).toBe(false);
    await store.idle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(store.warnings.some(w => w.includes('test write failure'))).toBe(false);
    expect(f.read('data.ttl')).toBe(data);
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('1');
});
