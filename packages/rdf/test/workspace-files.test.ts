import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFIXES, Doc, PREFIXES, compactIri, emptyShapes, boxes } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { ModelGraph, fileGraphIri } from '../src/graph';
import { parseTrig } from '../src/trig';
import { DATA, MODEL, SHAPES, WORKSPACE, doc, example, parseQuads, writeWorkspace, docOf } from './helpers';

const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});


/** A temporary folder with the fixture files; `workspace: false`: without the workspace file and its views (for create). */
function files({ workspace = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-files-'));
    dirs.push(dir);
    const f = (name: string, text: string) => { writeFileSync(join(dir, name), text); return join(dir, name); };
    return {
        dir, shapes: f('shapes.ttl', SHAPES), data: f('data.ttl', DATA), ws: workspace ? writeWorkspace(dir) : '',
        read: (name: string) => readFileSync(join(dir, name), 'utf8')
    };
}

async function opened(path: string): Promise<ModelStore> {
    const store = new ModelStore();
    const r = await store.open(path);
    if (!r.ok) throw new Error(r.error);
    return store;
}

const ok = (r: { ok: boolean; error?: string }) => { if (!r.ok) throw new Error(r.error); };
const viewId = (store: ModelStore, label: string) => Object.values(docOf(store).views).find(v => v.label === label)!.id;
const instanceId = (store: ModelStore, label: string) => Object.values(docOf(store).instances).find(i => i.label === label)!.id;

describe('workspace files', () => {
    it('loads the bundled bookshop example with both views, six domain instances and its value set', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'catenary-bookshop-'));
        dirs.push(dir);
        cpSync(new URL('../../../examples/bookshop/', import.meta.url), dir, { recursive: true });
        const store = await opened(join(dir, 'workspace.trig'));
        expect(store.warnings.filter(w => !w.startsWith('not committed:'))).toEqual([
            'Bookshop model: node for unknown instance urn:name:Cities%20member kept in the file, not shown'
        ]);
        const model = docOf(store);
        expect(Object.values(model.views).map(v => v.label).sort()).toEqual(['Bookshop', 'Bookshop model']);
        expect(Object.values(model.instances).map(i => i.label).sort()).toEqual([
            'Alice’s Adventures in Wonderland', 'Animal Farm', 'Cities', 'George Orwell',
            'Lewis Carroll', 'Little corner Bookshop', 'Nineteen Eighty-Four', 'Tangamandapio', 'Tanganana'
        ]);
        expect(store.files.views).toHaveLength(2);
        expect(store.files.files).toHaveLength(3);
    });

    it('files without roles (ADR 0004): every RDF file of the folder is read; shapes go to the graph of their file, the rest to the model graph', async () => {
        const f = files();
        mkdirSync(join(f.dir, 'sub'));
        writeFileSync(join(f.dir, 'sub', 'more.ttl'), '<urn:x:m> a <http://www.w3.org/ns/prov#Agent> ; <http://www.w3.org/2000/01/rdf-schema#label> "More" .\n');
        writeFileSync(join(f.dir, 'old.ttl.bak'), '<urn:x:b> a <http://www.w3.org/ns/prov#Agent> ; <http://www.w3.org/2000/01/rdf-schema#label> "Backup" .\n');
        mkdirSync(join(f.dir, '.hidden'));
        writeFileSync(join(f.dir, '.hidden', 'h.ttl'), '<urn:x:h> a <http://www.w3.org/ns/prov#Agent> ; <http://www.w3.org/2000/01/rdf-schema#label> "Hidden" .\n');
        mkdirSync(join(f.dir, 'nested'));
        writeFileSync(join(f.dir, 'nested', 'w.trig'), '<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> . }\n');
        writeFileSync(join(f.dir, 'nested', 'n.ttl'), '<urn:x:n> a <http://www.w3.org/ns/prov#Agent> ; <http://www.w3.org/2000/01/rdf-schema#label> "Nested" .\n');
        const store = await opened(f.ws);
        const graphs = () => new Set((store as unknown as { graph: ModelGraph }).graph.quads().map(q => q.graph.value));
        expect(graphs().has(fileGraphIri(f.shapes))).toBe(true);
        expect(graphs().has(fileGraphIri(f.data))).toBe(false);
        expect(store.files.files.map(x => [x.path.slice(f.dir.length + 1).split(sep).join('/'), x.kinds])).toEqual([['data.ttl', ['instances']], ['shapes.ttl', ['shapes']], ['sub/more.ttl', ['instances']]]);
        const labels = Object.values(docOf(store).instances).map(i => i.label);
        expect(labels).toContain('More');
        expect(labels.filter(l => ['Backup', 'Hidden', 'Nested'].includes(l))).toEqual([]);
        expect(docOf(store).instances[instanceId(store, 'More')].file).toBe(join(f.dir, 'sub', 'more.ttl'));
        expect(store.files.defaultFile).toEqual({ path: f.data, set: true });
    });

    it('an edit of a subject goes to its file; a new instance goes near its class, a new node shape to the default file', async () => {
        const f = files();
        // data.ttl has one dpm:Domain; domains.ttl two: a new domain goes to domains.ttl.
        writeFileSync(join(f.dir, 'agents.ttl'), '@prefix dpm: <osg://vocab/data-product-draft#> .\n<urn:x:a1> a dpm:Domain ; <http://www.w3.org/2000/01/rdf-schema#label> "A1" .\n<urn:x:a2> a dpm:Domain ; <http://www.w3.org/2000/01/rdf-schema#label> "A2" .\n');
        const store = await opened(f.ws);
        const agents = f.read('agents.ttl');
        ok(store.execute({ kind: 'rename', id: instanceId(store, 'A1'), label: 'A one' }));
        await store.idle();
        expect(f.read('agents.ttl')).toBe(agents.replace('"A1"', '"A one"'));
        ok(store.execute({ kind: 'createInstance', classIri: 'osg://vocab/data-product-draft#Domain', label: 'A3' }));
        await store.idle();
        expect(f.read('agents.ttl')).toContain('"A3"');
        expect(store.files.defaultFile).toEqual({ path: f.data, set: true });
        ok(store.execute({ kind: 'createNodeShape', label: 'Repository' }));
        await store.idle();
        expect(f.read('data.ttl')).toContain('"Repository"');
        expect(f.read('shapes.ttl')).not.toContain('Repository');
        const again = await opened(f.ws);
        expect(Object.values(docOf(again).shapes.nodeShapes).map(n => n.label)).toContain('Repository');
        expect(docOf(again).instances[instanceId(again, 'A3')].file).toBe(join(f.dir, 'agents.ttl'));
    });

    it('RDF lists of shapes with IRI cells, and orphan cells of shapes (written by earlier saves), stay with the shapes', async () => {
        const f = files();
        writeFileSync(join(f.dir, 'or.ttl'), `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
<urn:x:S> a sh:NodeShape ; sh:targetClass <urn:x:C> ; sh:or <urn:x:S-or> .
<urn:x:S-or> rdf:first <urn:x:P1> ; rdf:rest <urn:x:S-or-2> .
<urn:x:S-or-2> rdf:first <urn:x:P2> ; rdf:rest rdf:nil .
<urn:x:P1> sh:path <urn:x:p1> . <urn:x:P2> sh:path <urn:x:p2> .
<urn:x:orphan> rdf:first <urn:x:P1> ; rdf:rest <urn:x:orphan-2> . <urn:x:orphan-2> rdf:first <urn:x:P2> ; rdf:rest rdf:nil .\n`);
        const store = await opened(f.ws);
        expect(store.warnings.filter(w => w.includes('urn:x:'))).toEqual([]);
        const shape = Object.values(docOf(store).shapes.nodeShapes).find(n => n.uri === 'urn:x:S')!;
        expect(Object.values(docOf(store).shapes.constraints).filter(c => c.owner === shape.id).map(c => c.operator)).toEqual(['or']);
        expect(store.files.files.find(x => x.path.endsWith('or.ttl'))!.kinds).toEqual(['shapes']);
    });

    it('setSettings writes the file of each kind and the exclude globs to the manifest; an exclude reads the files again', async () => {
        const f = files();
        writeFileSync(join(f.dir, 'agents.ttl'), '<urn:x:a1> a <http://www.w3.org/ns/prov#Agent> ; <http://www.w3.org/2000/01/rdf-schema#label> "A1" .\n');
        const store = await opened(f.ws);
        ok(await store.setSettings({ placement: { instances: 'new/defaults.ttl', concepts: 'near' } }));
        await store.idle();
        expect(store.files.placement).toMatchObject({ instances: join(f.dir, 'new', 'defaults.ttl'), concepts: 'near' });
        const manifest = (await parseTrig(f.read('workspace.trig'))).quads.map(q => [q.predicate.value.replace(/^.*#/, ''), q.object.value]);
        expect(manifest).toEqual(expect.arrayContaining([['placeInstances', 'new/defaults.ttl'], ['placeConcepts', 'near'], ['placeShapes', 'data.ttl']]));
        ok(store.execute({ kind: 'createInstance', classIri: 'http://www.w3.org/ns/prov#Agent', label: 'A2' }));
        await store.idle();
        expect(f.read('new/defaults.ttl')).toContain('"A2"');
        ok(await store.setSettings({ exclude: ['agents.ttl'] }));
        expect(Object.values(docOf(store).instances).map(i => i.label)).not.toContain('A1');
        ok(await store.setSettings({ defaultFile: 'new/defaults.ttl' }));
        expect(store.files.defaultFile).toEqual({ path: join(f.dir, 'new', 'defaults.ttl'), set: true });
        await store.idle();
        expect((await parseTrig(f.read('workspace.trig'))).quads.map(q => q.predicate.value.replace(/^.*#/, ''))).toContain('defaultFile');
        ok(await store.setSettings({ defaultFile: '' }));
        await store.idle();
        expect(store.files.defaultFile?.set).toBe(false);
        expect((await parseTrig(f.read('workspace.trig'))).quads.map(q => q.predicate.value.replace(/^.*#/, ''))).not.toContain('defaultFile');
        expect((await store.setSettings({ defaultFile: '../outside.ttl' })).ok).toBe(false);
        expect((await store.setSettings({ placement: { shapes: 'nowhere' } })).ok).toBe(false);
        expect((await store.setSettings({ placement: { shapes: '../outside.ttl' } })).ok).toBe(false);
        expect((await store.setSettings({ placement: { shapes: 'workspace.trig' } })).ok).toBe(false);
    });

    it('a file reference keeps the path relative to its view file; a removed target file shows as broken', async () => {
        const f = files();
        writeFileSync(join(f.dir, 'notes.md'), '# notes\n');
        const store = await opened(f.ws);
        const view = Object.values(docOf(store).views)[0];
        const made = store.execute({ kind: 'addFileReference', view: view.id, file: join(f.dir, 'notes.md'), at: { x: 0, y: 0 } });
        ok(made);
        await store.idle();
        const ref = () => docOf(store).views[view.id].boxes.find(b => b.kind === 'reference' && b.file)!;
        expect(ref()).toMatchObject({ file: '../notes.md', path: join(f.dir, 'notes.md'), broken: false });
        const rows = (await parseTrig(f.read('views/product-context.view.trig'))).quads.filter(q => q.predicate.value === 'osg://vocab/view#file').map(q => q.object.value);
        expect(rows).toEqual(['../notes.md']);
        rmSync(join(f.dir, 'notes.md'));
        await store.syncFromDisk();
        expect(ref()).toMatchObject({ broken: true });
        const again = await opened(f.ws);
        expect(docOf(again).views[view.id].boxes.find(b => b.kind === 'reference' && b.file)).toMatchObject({ file: '../notes.md', broken: true });
    });

    it('no default file in the manifest: the first model file by path', async () => {
        const f = files();
        writeFileSync(f.ws, '<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> . }\n');
        writeFileSync(join(f.dir, 'agents.ttl'), '<urn:x:a1> a <http://www.w3.org/ns/prov#Agent> ; <http://www.w3.org/2000/01/rdf-schema#label> "A1" .\n');
        const store = await opened(f.ws);
        expect(store.files.defaultFile).toEqual({ path: join(f.dir, 'agents.ttl'), set: false });
    });

    it('manifest: default file, placement and exclude are read and written; the legacy placement "default" puts a new instance in the default file', async () => {
        const f = files();
        writeFileSync(join(f.dir, 'agents.ttl'), '<urn:x:a1> a <http://www.w3.org/ns/prov#Agent> ; <http://www.w3.org/2000/01/rdf-schema#label> "A1" .\n');
        writeFileSync(join(f.dir, 'skip.ttl'), '<urn:x:s> a <http://www.w3.org/ns/prov#Agent> ; <http://www.w3.org/2000/01/rdf-schema#label> "Skipped" .\n');
        writeFileSync(f.ws, `<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> ; <osg://vocab/workspace#defaultFile> "data.ttl" ;
            <osg://vocab/workspace#placeInstances> "default" ; <osg://vocab/workspace#exclude> "skip*.ttl" . }\n`);
        const store = await opened(f.ws);
        expect(store.files).toMatchObject({ defaultFile: { path: f.data, set: true }, placement: { shapes: f.data, concepts: 'near', instances: f.data }, exclude: ['skip*.ttl'] });
        expect(Object.values(docOf(store).instances).map(i => i.label)).not.toContain('Skipped');
        ok(store.execute({ kind: 'createInstance', classIri: 'http://www.w3.org/ns/prov#Agent', label: 'A2' }));
        await store.idle();
        expect(f.read('data.ttl')).toContain('"A2"');
        expect(f.read('agents.ttl')).not.toContain('"A2"');
    });

    it('prefixes: defaults without declarations (file clean); a change is stored in the workspace file and read back', async () => {
        const f = files();
        let store = await opened(f.ws);
        expect(store.snapshot().prefixes).toEqual({ table: { ...DEFAULT_PREFIXES }, stored: false });
        expect(store.dirty).toBe(false);
        expect((await store.setPrefixes({ ...DEFAULT_PREFIXES, 'not a prefix': 'urn:x:' })).ok).toBe(false);
        expect((await store.setPrefixes({ ex: 'http://example.org/', dcat: 'http://example.org/' })).ok).toBe(false);
        ok(await store.setPrefixes({ ex: 'http://example.org/', xsd: DEFAULT_PREFIXES.xsd }));
        expect(compactIri('http://example.org/a')).toBe('ex:a');
        expect(store.dirty).toBe(true);
        ok(await store.save());
        store = await opened(f.ws);
        expect(store.snapshot().prefixes).toEqual({ table: { ex: 'http://example.org/', xsd: DEFAULT_PREFIXES.xsd }, stored: true });
        expect(store.dirty).toBe(false);
        expect(PREFIXES).toEqual({ ex: 'http://example.org/', xsd: DEFAULT_PREFIXES.xsd });
    });

    it('prefixes: a patched file uses a workspace prefix that it does not declare, and gets its directive', async () => {
        const f = files();
        const store = await opened(f.ws);
        ok(await store.setPrefixes({ ...DEFAULT_PREFIXES, n: 'urn:name:' }));
        ok(store.execute({ kind: 'createInstance', classIri: 'http://www.w3.org/ns/prov#Agent', label: 'Ann' }));
        ok(await store.save());
        const text = f.read('data.ttl');
        expect(text.startsWith(DATA.slice(0, DATA.indexOf('\n\n')) + '\n@prefix n: <urn:name:>.\n\n')).toBe(true);
        expect(text).toContain('\nn:Ann a prov:Agent;');
        expect(store.snapshot().warnings.filter(w => w.startsWith('data.ttl'))).toEqual([]); // a patch, not a whole-file write
    });


    it('a removed setting: an old ws:exportViews list opens clean and the next manifest write drops it', async () => {
        const f = files();
        // As the removed writer wrote it: list cells named after the manifest.
        writeFileSync(f.ws, f.read('workspace.trig').replace('ws:defaultFile "data.ttl".', 'ws:defaultFile "data.ttl";\n'
            + '    ws:exportViews <urn:name:workspace-exportViews-1>.\n'
            + '  <urn:name:workspace-exportViews-1> rdf:first <urn:name:Product%20context>; rdf:rest rdf:nil.'));
        const store = await opened(f.ws);
        expect(store.dirty).toBe(false);
        ok(await store.setPrefixes({ ...DEFAULT_PREFIXES, n: 'urn:name:' }));
        ok(await store.save());
        const quads = (await parseTrig(f.read('workspace.trig'))).quads;
        expect(quads.filter(q => q.predicate.value.endsWith('exportViews') || q.predicate.value.endsWith('#first'))).toEqual([]);
    });

    it('workspace file + data file + shapes give the same model as the one-file fixture, and open clean', async () => {
        const f = files();
        const store = await opened(f.ws);
        // The one-file fixture has no shapes graphs.
        // Blank nodes of a view get skolem IRIs in the order of the text (skolem.ts): a view file and the one-file TriG differ in
        // that order. Compare the views with those ids replaced.
        const views = (d: Doc) => JSON.parse(JSON.stringify(d.views).replace(/n-urn_3aname_3aProduct_2520context_2d[A-Za-z0-9_]*/g, 'skolem'));
        const want = doc(await example());
        const noFile = (d: Doc) => ({ ...d, instances: Object.fromEntries(Object.entries(d.instances).map(([k, { file: _f, ...i }]) => [k, i])) });
        expect({ ...noFile(docOf(store)), shapes: emptyShapes(), views: {} }).toEqual({ ...want, views: {} });
        const sortBoxes = (v: Record<string, { boxes: unknown[] }>) => Object.values(v).map(x => ({ ...x, boxes: x.boxes.map(b => JSON.stringify(b)).sort() }));
        expect(sortBoxes(views(docOf(store)))).toEqual(sortBoxes(views(want)));
        expect(store.meta.classes.length).toBeGreaterThan(0);
        expect(store.dirty).toBe(false);
        expect(store.files.files.map(x => [x.path, x.dirty])).toEqual([[f.data, false], [f.shapes, false]]);
    });

    it('an instance edit changes only the data file, a layout edit only the view file', async () => {
        const f = files();
        const store = await opened(f.ws);
        ok(store.execute({ kind: 'rename', id: instanceId(store, 'Product usage data'), label: 'Renamed' }));
        expect(store.files.files.find(x => x.path === f.data)!.dirty).toBe(true);
        expect(store.files.views[0].dirty).toBe(false);
        ok(await store.save());
        expect(f.read('data.ttl')).toContain('Renamed');
        expect(f.read('workspace.trig')).toBe(WORKSPACE);
        const view = Object.values(docOf(store).views)[0];
        ok(store.execute({ kind: 'setViewElements', view: view.id, ids: [boxes(view, 'card')[0].id], patch: { x: 4321 } }));
        expect(store.files).toMatchObject({ workspace: { dirty: false }, views: [{ dirty: true }] });
        expect(store.files.files.some(x => x.dirty)).toBe(false);
        ok(await store.save());
        expect(f.read('views/product-context.view.trig')).toContain('4321');
        expect(f.read('workspace.trig')).toBe(WORKSPACE);
        expect(f.read('data.ttl')).not.toContain('4321');
        expect(store.dirty).toBe(false);
    });

    it('view files: a new view gets <label>.view.trig; rename and IRI change keep the file; a delete removes it at save; undo writes it again', async () => {
        const f = files();
        const store = await opened(f.ws);
        const made = store.execute({ kind: 'createView', label: 'Road map' });
        ok(made);
        const id = (made as { id: string }).id;
        expect(store.files.views.find(v => v.view === id)).toEqual({ view: id, path: join(f.dir, 'views', 'road-map.view.trig'), dirty: true });
        ok(await store.save());
        expect(f.read('views/road-map.view.trig')).toContain('Road map');
        ok(store.execute({ kind: 'rename', id, label: 'Plan' }));
        ok(store.execute({ kind: 'setUri', id: viewId(store, 'Plan'), uri: 'urn:name:moved' }));
        ok(await store.save());
        expect(f.read('views/road-map.view.trig')).toContain('urn:name:moved');
        expect(readdirSync(join(f.dir, 'views')).sort()).toEqual(['product-context.view.trig', 'road-map.view.trig']);
        ok(store.execute({ kind: 'delete', ids: [viewId(store, 'Plan')] }));
        expect(store.dirty).toBe(true);
        ok(await store.save());
        expect(existsSync(join(f.dir, 'views', 'road-map.view.trig'))).toBe(false);
        store.undo();
        ok(await store.save());
        expect(f.read('views/plan.view.trig')).toContain('urn:name:moved');
        const again = await opened(f.ws);
        expect(Object.values(docOf(again).views).map(v => v.label).sort()).toEqual(['Plan', 'Product context']);
        expect(again.dirty).toBe(false);
    });

    it('a new view with a folder gets its view file in that folder; a folder outside the workspace folder is refused', async () => {
        const f = files();
        const store = await opened(f.ws);
        mkdirSync(join(f.dir, 'docs', 'drafts'), { recursive: true });
        const made = store.execute({ kind: 'createView', label: 'Catenary', folder: join(f.dir, 'docs', 'drafts') });
        ok(made);
        const id = (made as { id: string }).id;
        expect(store.files.views.find(v => v.view === id)?.path).toBe(join(f.dir, 'docs', 'drafts', 'catenary.view.trig'));
        const next = store.execute({ kind: 'createView', label: 'Next' });
        ok(next);
        expect(store.files.views.find(v => v.view === (next as { id: string }).id)?.path).toBe(join(f.dir, 'views', 'next.view.trig'));
        const outside = store.execute({ kind: 'createView', label: 'Out', folder: tmpdir() });
        expect(outside.ok).toBe(false);
        expect(Object.values(docOf(store).views).some(v => v.label === 'Out')).toBe(false);
        ok(await store.save());
        expect(f.read('docs/drafts/catenary.view.trig')).toContain('Catenary');
    });

    it('a new view with a file gets that file, any .trig name; the file of a rename does not change; a file that exists, is not TriG or is outside the workspace is refused', async () => {
        const f = files();
        const store = await opened(f.ws);
        // law_newViewFileWins
        const made = store.execute({ kind: 'createView', label: 'unnamed view 1', file: 'plans/road.trig' });
        ok(made);
        const id = (made as { id: string }).id;
        expect(store.files.views.find(v => v.view === id)?.path).toBe(join(f.dir, 'plans', 'road.trig'));
        ok(store.execute({ kind: 'rename', id, label: 'Road map' }));
        ok(await store.save());
        expect(f.read('plans/road.trig')).toContain('Road map');
        for (const file of ['plans/road.trig', 'data.ttl', 'views/product-context.view.trig', 'plans/road.ttl', join(tmpdir(), 'out.trig')]) {
            expect(store.execute({ kind: 'createView', label: 'unnamed view 2', file }).ok).toBe(false);
        }
        expect(Object.values(docOf(store).views).map(v => v.label).sort()).toEqual(['Product context', 'Road map']);
        const again = await opened(f.ws);
        expect(again.files.views.find(v => v.view === viewId(again, 'Road map'))?.path).toBe(join(f.dir, 'plans', 'road.trig'));
        expect(again.dirty).toBe(false);
    });

    it('a view file is a TriG file (any name, any folder) that declares a view, or a *.view.trig file: one graph, named by its view:View; other files with a view: not read, with a warning', async () => {
        const f = files();
        const body = (iri: string, label: string) => `<${iri}> a <osg://vocab/view#View> ; <http://www.w3.org/2000/01/rdf-schema#label> "${label}" .`;
        const view = (iri: string, label: string, graph = iri) => `<${graph}> { ${body(iri, label)} }\n`;
        mkdirSync(join(f.dir, 'views', 'drafts'));
        writeFileSync(join(f.dir, 'views', 'drafts', 'idea.view.trig'), view('urn:name:Idea', 'Idea'));
        writeFileSync(join(f.dir, 'views', 'two.view.trig'), view('urn:name:A', 'A') + view('urn:name:B', 'B'));
        writeFileSync(join(f.dir, 'views', 'none.view.trig'), '<urn:g> { <urn:x> <urn:p> 1 . }\n');
        writeFileSync(join(f.dir, 'views', 'other-graph.view.trig'), view('urn:name:C', 'C', 'urn:g'));
        writeFileSync(join(f.dir, 'views', 'zz-copy.view.trig'), view('urn:name:Idea', 'Idea copy'));
        writeFileSync(join(f.dir, 'notes.ttl'), body('urn:name:Notes', 'Notes') + '\n');
        // The content decides, not the name: a TriG file that declares a view is a view file.
        writeFileSync(join(f.dir, 'plan.trig'), view('urn:name:Plan', 'Plan'));
        writeFileSync(join(f.dir, 'loose.trig'), view('urn:name:Loose', 'Loose', 'urn:g'));
        const store = await opened(f.ws);
        expect(Object.values(docOf(store).views).map(v => v.label).sort()).toEqual(['Idea', 'Plan', 'Product context']);
        expect(store.files.views.find(v => v.view === viewId(store, 'Plan'))!.path).toBe(join(f.dir, 'plan.trig'));
        expect(store.files.files.some(m => m.path === join(f.dir, 'plan.trig'))).toBe(false);
        expect(store.files.views.find(v => v.view === viewId(store, 'Idea'))!.path).toBe(join(f.dir, 'views', 'drafts', 'idea.view.trig'));
        expect(store.warnings.filter(w => w.includes('not read')).map(w => w.replace(/:.*/, '')).sort())
            .toEqual(['loose.trig', 'notes.ttl', 'views/none.view.trig', 'views/other-graph.view.trig', 'views/two.view.trig', 'views/zz-copy.view.trig']);
    });

    it('a workspace file with other graphs than the manifest (views of the old format) does not open', async () => {
        const f = files();
        const old = join(f.dir, 'old.trig');
        writeFileSync(old, MODEL);
        const r = await new ModelStore().open(old);
        expect(r).toMatchObject({ ok: false, error: expect.stringContaining('graphs other than the manifest') });
    });

    it('fileContent: a file holds a workspace, views, both or none, by its content; a view gets the workspace that reads it', async () => {
        const f = files();
        const store = await opened(f.ws);
        const view = (iri: string, label: string) => `<${iri}> { <${iri}> a <osg://vocab/view#View> ; <http://www.w3.org/2000/01/rdf-schema#label> "${label}" . }\n`;
        writeFileSync(join(f.dir, 'plan.trig'), view('urn:name:Plan', 'Plan'));
        mkdirSync(join(f.dir, 'other', 'deep'), { recursive: true });
        writeFileSync(join(f.dir, 'other', 'workspace.trig'), '<urn:name:workspace> { <urn:name:workspace> a <https://w3id.org/catenary/workspace#Workspace> . }\n');
        writeFileSync(join(f.dir, 'other', 'deep', 'far.trig'), view('urn:name:Far', 'Far'));
        writeFileSync(join(f.dir, 'both.trig'), '<urn:name:workspace> { <urn:name:workspace> <urn:p> 1 . }\n' + view('urn:name:Both', 'Both'));
        const lone = mkdtempSync(join(tmpdir(), 'catenary-lone-'));
        dirs.push(lone);
        writeFileSync(join(lone, 'lone.trig'), view('urn:name:Lone', 'Lone'));
        await store.idle();
        const plan = await store.fileContent(join(f.dir, 'plan.trig'));
        expect(plan).toEqual({ workspace: false, views: [{ id: expect.any(String), label: 'Plan' }], workspaceFile: f.ws });
        expect(await store.fileContent(f.ws)).toEqual({ workspace: true, views: [] });
        expect(await store.fileContent(join(f.dir, 'data.ttl'))).toEqual({ workspace: false, views: [] });
        expect(await store.fileContent(join(f.dir, 'both.trig'))).toMatchObject({ workspace: true, views: [{ label: 'Both' }], workspaceFile: f.ws });
        expect(await store.fileContent(join(f.dir, 'other', 'deep', 'far.trig'))).toMatchObject({ views: [{ label: 'Far' }], workspaceFile: join(f.dir, 'other', 'workspace.trig') });
        expect((await store.fileContent(join(lone, 'lone.trig'))).workspaceFile).toBeUndefined();
        // A view file of any name does not open as a workspace.
        expect(await new ModelStore().open(join(f.dir, 'plan.trig'))).toEqual({ ok: false, error: 'plan.trig is a view file. Open its workspace, then open the view.' });
    });

    it('a view file does not open as a workspace: an error that names it', async () => {
        const f = files();
        mkdirSync(join(f.dir, 'views'), { recursive: true });
        const file = join(f.dir, 'views', 'Flow.view.trig');
        writeFileSync(file, '<urn:name:Flow> { <urn:name:Flow> a <osg://vocab/view#View> . }\n');
        const r = await new ModelStore().open(file);
        expect(r).toEqual({ ok: false, error: 'Flow.view.trig is a view file. Open its workspace, then open the view.' });
    });

    it('a model file is written in its format (N-Triples, JSON-LD)', async () => {
        const f = files();
        writeFileSync(join(f.dir, 'more.nt'), '<urn:x:m> <http://www.w3.org/2000/01/rdf-schema#label> "More" .\n<urn:x:m> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/ns/prov#Agent> .\n');
        const store = await opened(f.ws);
        ok(store.execute({ kind: 'rename', id: instanceId(store, 'More'), label: 'More 2' }));
        await store.idle();
        expect(f.read('more.nt')).toMatch(/^<urn:x:m> <http:\/\/www.w3.org\/2000\/01\/rdf-schema#label> "More 2" \.$/m);
        expect(store.dirty).toBe(false);
    });

    it('create makes a workspace file with the proposed placement, an empty file for shapes and for SKOS, and views/main.view.trig', async () => {
        const f = files({ workspace: false });
        const store = new ModelStore(), dir = f.dir;
        ok(await store.create(join(dir, 'new.trig')));
        expect(store.files).toMatchObject({
            workspace: { path: join(dir, 'new.trig') },
            placement: { shapes: join(dir, 'new.shapes.ttl'), concepts: join(dir, 'new.skos.ttl'), instances: 'near' }
        });
        const manifest = (await parseTrig(f.read('new.trig'))).quads.map(q => [q.predicate.value.replace(/^.*#/, ''), q.object.value]);
        expect(manifest).toEqual(expect.arrayContaining([['placeShapes', 'new.shapes.ttl'], ['placeConcepts', 'new.skos.ttl'], ['placeInstances', 'near']]));
        expect(manifest.map(([p]) => p)).not.toContain('defaultFile');
        expect(store.files.views.map(v => v.path)).toEqual([join(dir, 'views', 'main.view.trig')]);
        expect(existsSync(join(dir, 'new.shapes.ttl')) && existsSync(join(dir, 'new.skos.ttl'))).toBe(true);
        expect(store.dirty).toBe(false);
        // Near its kind: not the file of shapes or SKOS (the default file excludes them).
        ok(store.execute({ kind: 'createInstance', classIri: 'urn:x:NewClass', label: 'A1' }));
        await store.idle();
        expect(f.read('new.shapes.ttl') + f.read('new.skos.ttl')).not.toContain('"A1"');
        expect(store.defaultFile).not.toMatch(/\.(shapes|skos)\.ttl$/);
        // The placement given at create: a path relative to the folder, or "near".
        const other = new ModelStore(), sub = join(dir, 'other');
        mkdirSync(join(sub), { recursive: true });
        mkdirSync(join(dir, 'bad'), { recursive: true });
        ok(await other.create(join(sub, 'other.trig'), { shapes: 'near', instances: 'data/other.ttl' }));
        expect(other.files.placement).toEqual({ shapes: 'near', concepts: join(sub, 'other.skos.ttl'), instances: join(sub, 'data', 'other.ttl') });
        expect(existsSync(join(sub, 'data', 'other.ttl'))).toBe(true);
        expect((await new ModelStore().create(join(dir, 'bad', 'bad.trig'), { shapes: '../outside.ttl' })).ok).toBe(false);
    });
});

describe('shapes files in the store', () => {
    const classOf = (store: ModelStore, name: string) => store.meta.classes.find(c => c.name === name);

    it('a failed shape creation writes nothing', async () => {
        const f = files({ workspace: false });
        const store = new ModelStore();
        ok(await store.create(join(f.dir, 'repo.trig')));
        expect(store.execute({ kind: 'createNodeShape', label: '' }).ok).toBe(false);
        expect(store.dirty).toBe(false);
    });

    it('a shape edit changes only the shapes file, rebuilds the metamodel, and a save writes the file', async () => {
        const f = files();
        const store = await opened(f.ws);
        const shape = Object.values(docOf(store).shapes.nodeShapes).find(s => s.label === 'Dataset')!;
        const version = store.shapesVersion;
        ok(store.execute({ kind: 'rename', id: shape.id, label: 'Data asset' }));
        expect(docOf(store).shapes.nodeShapes[shape.id].label).toBe('Data asset');
        // The class keeps its own name: a shape name does not rename the class.
        expect(classOf(store, 'Data asset')).toBeUndefined();
        expect(classOf(store, 'dcat:Dataset')).toBeDefined();
        expect(store.shapesVersion).toBeGreaterThan(version);
        expect(store.files.files.filter(x => x.dirty).map(x => x.path)).toEqual([f.shapes]);
        expect(store.files.workspace!.dirty).toBe(false);
        expect(store.files.views.some(v => v.dirty)).toBe(false);
        ok(await store.save());
        expect(store.dirty).toBe(false);
        expect(f.read('shapes.ttl')).toContain('"Data asset"');
        const again = await opened(f.ws);
        expect(docOf(again).shapes.nodeShapes[shape.id].label).toBe('Data asset');
        expect(again.dirty).toBe(false);
    });

    it('a path rename with data queues a migration; undo and redo restore the queue; applying it changes the data', async () => {
        const f = files();
        const store = await opened(f.ws);
        const p = Object.values(docOf(store).shapes.properties).find(x => x.path.kind === 'iri' && x.path.iri === 'https://ekgf.github.io/dprod/purpose')!;
        ok(store.execute({ kind: 'setPropertyShape', id: p.id, patch: { path: { kind: 'iri', iri: 'https://ekgf.github.io/dprod/goal' } } }));
        const [m] = store.snapshot().migrations;
        expect(m).toMatchObject({ kind: 'renamePredicate', from: 'https://ekgf.github.io/dprod/purpose', to: 'https://ekgf.github.io/dprod/goal' });
        expect(m.count).toBeGreaterThan(0);
        store.undo();
        expect(store.snapshot().migrations).toEqual([]);
        store.redo();
        expect(store.snapshot().migrations.map(x => x.id)).toEqual([m.id]);
        ok(store.execute({ kind: 'migrateData', migration: m }));
        expect(store.snapshot().migrations).toEqual([]);
        expect(store.files.files.find(x => x.path === f.data)!.dirty).toBe(true);
        store.undo();
        expect(store.snapshot().migrations.map(x => x.id)).toEqual([m.id]);
        store.dismissMigration(m.id);
        expect(store.snapshot().migrations).toEqual([]);
    });

    it('a rename of a class (target class) or a predicate (path): shapes, vocabulary and views follow, each statement in its file; the data waits for the migration', async () => {
        const f = files();
        const RDFS = 'http://www.w3.org/2000/01/rdf-schema#', DCAT = 'http://www.w3.org/ns/dcat#', EX = 'http://example.org/';
        writeFileSync(join(f.dir, 'vocab.ttl'), `<${DCAT}Dataset> a <${RDFS}Class> ; <${RDFS}comment> "A dataset" .
<${EX}Sub> <${RDFS}subClassOf> <${DCAT}Dataset> .
<https://ekgf.github.io/dprod/purpose> <${RDFS}domain> <${DCAT}Dataset> ; <${RDFS}comment> "Why" .
`);
        const store = await opened(f.ws);
        const triples = async (name: string) => (await parseQuads(f.read(name))).map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`);
        const uses = async (name: string, iri: string) => (await triples(name)).filter(t => t.split(' ').includes(iri)).sort();
        const before = { vocab: await uses('vocab.ttl', DCAT + 'Dataset'), shapes: (await uses('shapes.ttl', DCAT + 'Dataset')).length, data: (await uses('data.ttl', DCAT + 'Dataset')).length };
        expect(before.shapes).toBeGreaterThan(1);
        expect(before.data).toBeGreaterThan(0);
        const shape = Object.values(docOf(store).shapes.nodeShapes).find(s => s.targetClass === DCAT + 'Dataset')!;
        ok(store.execute({ kind: 'setNodeShape', id: shape.id, patch: { targetClass: EX + 'Data' } }));
        ok(await store.save());
        // Vocabulary: renamed in vocab.ttl, nothing moved to another file.
        expect(await uses('vocab.ttl', EX + 'Data')).toEqual(before.vocab.map(t => t.replaceAll(DCAT + 'Dataset', EX + 'Data')).sort());
        expect(await uses('vocab.ttl', DCAT + 'Dataset')).toEqual([]);
        // Shapes: sh:targetClass and every sh:class reference.
        expect(await uses('shapes.ttl', DCAT + 'Dataset')).toEqual([]);
        expect((await uses('shapes.ttl', EX + 'Data')).length).toBe(before.shapes);
        expect(await uses('data.ttl', EX + 'Data')).toEqual([]);
        // Data: rdf:type waits for the migration.
        expect((await uses('data.ttl', DCAT + 'Dataset')).length).toBe(before.data);
        expect(store.snapshot().migrations).toMatchObject([{ kind: 'renameClass', from: DCAT + 'Dataset', to: EX + 'Data' }]);
        // A path rename: the vocabulary of the predicate follows.
        const P = 'https://ekgf.github.io/dprod/purpose';
        const p = Object.values(docOf(store).shapes.properties).find(x => x.path.kind === 'iri' && x.path.iri === P)!;
        ok(store.execute({ kind: 'setPropertyShape', id: p.id, patch: { path: { kind: 'iri', iri: EX + 'goal' } } }));
        ok(await store.save());
        expect(await uses('vocab.ttl', EX + 'goal')).toEqual([`${EX}goal ${RDFS}comment Why`, `${EX}goal ${RDFS}domain ${EX}Data`]);
        expect(await uses('vocab.ttl', P)).toEqual([]);
        // Undo: the files as before.
        store.undo();
        store.undo();
        ok(await store.save());
        expect(await uses('vocab.ttl', DCAT + 'Dataset')).toEqual(before.vocab);
        expect((await uses('shapes.ttl', DCAT + 'Dataset')).length).toBe(before.shapes);
        // Another shape with the old class: a retarget of one shape, not a rename.
        ok(store.execute({ kind: 'createNodeShape', label: 'Other', targetClass: DCAT + 'Dataset' }));
        ok(store.execute({ kind: 'setNodeShape', id: shape.id, patch: { targetClass: EX + 'Data' } }));
        ok(await store.save());
        expect(await uses('vocab.ttl', DCAT + 'Dataset')).toEqual(before.vocab);
        expect((await uses('shapes.ttl', EX + 'Data')).length).toBe(1);
    });

    it('an edit is written at once; a change made on disk by another program is read and clears the undo stack', async () => {
        const f = files();
        const store = await opened(f.ws);
        const shape = Object.values(docOf(store).shapes.nodeShapes)[0];
        ok(store.execute({ kind: 'rename', id: shape.id, label: 'Changed' }));
        await store.idle();
        expect(store.dirty).toBe(false);
        expect(f.read('shapes.ttl')).toContain('"Changed"');
        writeFileSync(f.shapes, f.read('shapes.ttl').replace('"Changed"', '"Outside"'));
        expect(await store.syncFromDisk()).toEqual(['shapes.ttl']);
        expect(store.canUndo).toBe(false);
        expect(store.dirty).toBe(false);
        expect(Object.values(docOf(store).shapes.nodeShapes).map(s => s.label)).toContain('Outside');
    });

    it('git: each write is one commit of the written files; staged changes of the user stay out; an undo removes a new view file', async () => {
        const f = files();
        const git = (...args: string[]) => execFileSync('git', args, { cwd: f.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        git('init', '-q');
        git('config', 'user.name', 'Test');
        git('config', 'user.email', 'test@example.org');
        git('add', '-A');
        git('commit', '-q', '-m', 'start');
        writeFileSync(join(f.dir, 'notes.txt'), 'mine\n');
        git('add', 'notes.txt');
        const store = await opened(f.ws);
        ok(store.execute({ kind: 'rename', id: instanceId(store, 'Product usage data'), label: 'Renamed' }));
        await store.idle();
        expect(git('log', '-1', '--format=%s')).toBe('Catenary: rename');
        expect(git('show', '--name-only', '--format=', 'HEAD')).toBe('data.ttl');
        expect(git('diff', '--cached', '--name-only')).toBe('notes.txt');
        ok(store.execute({ kind: 'createView', label: 'Road map' }));
        await store.idle();
        expect(git('show', '--name-status', '--format=', 'HEAD')).toBe('A\tviews/road-map.view.trig');
        store.undo();
        await store.idle();
        expect(git('log', '-1', '--format=%s')).toBe('Catenary: undo');
        expect(git('show', '--name-status', '--format=', 'HEAD')).toBe('D\tviews/road-map.view.trig');
        expect(git('status', '--porcelain')).toBe('A  notes.txt');
        expect(store.warnings.filter(w => w.startsWith('Not '))).toEqual([]);
    });

    it('a blank node of the data file that a view shows gets its IRI in the data file; the view shows it after a new open', async () => {
        const f = files();
        writeFileSync(f.data, DATA + '\n<urn:name:Home%20owner> a <http://www.w3.org/ns/prov#Agent> ; <http://www.w3.org/2000/01/rdf-schema#label> "Home owner" ;\n    <urn:ex:address> [ a <http://www.w3.org/ns/prov#Location> ; <http://www.w3.org/2000/01/rdf-schema#label> "Home" ] .\n');
        const store = await opened(f.ws);
        const home = instanceId(store, 'Home');
        const view = Object.values(docOf(store).views)[0];
        ok(store.execute({ kind: 'addToView', view: view.id, ids: [home], at: { x: 0, y: 0 } }));
        await store.idle();
        expect(store.warnings.filter(w => w.startsWith('Not '))).toEqual([]);
        const iri = docOf(store).instances[home].uri;
        expect(f.read('data.ttl')).toContain(`<urn:ex:address> <${iri}>`);
        const again = await opened(f.ws);
        expect(boxes(docOf(again).views[view.id], 'card').some(b => b.element === home)).toBe(true);
        expect(docOf(again).instances[home].label).toBe('Home');
    });

    it('a file changed on disk since it was read is not overwritten: the write fails with a warning, the edit stays pending', async () => {
        const f = files();
        const store = await opened(f.ws);
        writeFileSync(f.data, f.read('data.ttl') + '\n# changed by another program\n');
        ok(store.execute({ kind: 'rename', id: instanceId(store, 'Product usage data'), label: 'Renamed' }));
        await store.idle();
        expect(f.read('data.ttl')).toContain('# changed by another program');
        expect(f.read('data.ttl')).not.toContain('Renamed');
        expect(store.dirty).toBe(true);
        expect(store.warnings.some(w => w.startsWith('Not written:') && w.includes('changed on disk'))).toBe(true);
    });
});

describe('open a folder', () => {
    const manifestText = '<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> . }\n';

    it('a folder with workspace.trig opens it', async () => {
        const f = files();
        const store = await opened(f.dir);
        expect(store.file).toBe(f.ws);
        expect(store.files.workspace).toEqual({ path: f.ws, dirty: false, onDisk: true });
    });

    it('a folder with one workspace file of another name opens it; a .trig model file is not a workspace file', async () => {
        const f = files({ workspace: false });
        writeFileSync(join(f.dir, 'model.trig'), '<urn:g> { <urn:x:a> a <http://www.w3.org/ns/prov#Agent> . }\n');
        const ws = writeWorkspace(f.dir, 'library.trig');
        expect((await opened(f.dir)).file).toBe(ws);
    });

    it('a folder with several workspace files: an error that names them', async () => {
        const f = files({ workspace: false });
        writeFileSync(join(f.dir, 'a.trig'), manifestText);
        writeFileSync(join(f.dir, 'b.trig'), manifestText);
        const r = await new ModelStore().open(f.dir);
        expect(r).toEqual({ ok: false, error: `${f.dir} has 2 workspace files (a.trig, b.trig): open one of them.` });
    });

    it('a folder without a workspace file opens with the default settings; an edit does not write it, a setting does', async () => {
        const f = files({ workspace: false });
        const store = await opened(f.dir);
        const ws = join(f.dir, 'workspace.trig');
        expect(store.file).toBe(ws);
        expect(store.files.workspace).toEqual({ path: ws, dirty: false, onDisk: false });
        expect(store.files.files.map(x => x.path.slice(f.dir.length + 1))).toEqual(['data.ttl', 'shapes.ttl']);
        ok(store.execute({ kind: 'createInstance', classIri: 'http://www.w3.org/ns/prov#Agent', label: 'A2' }));
        await store.idle();
        expect(existsSync(ws)).toBe(false);
        expect(f.read('data.ttl')).toContain('"A2"');
        ok(await store.setSettings({ placement: { instances: 'data.ttl' } }));
        await store.idle();
        const manifest = (await parseTrig(f.read('workspace.trig'))).quads.map(q => [q.predicate.value.replace(/^.*#/, ''), q.object.value]);
        expect(manifest).toEqual(expect.arrayContaining([['placeInstances', 'data.ttl']]));
        expect(store.files.workspace).toEqual({ path: ws, dirty: false, onDisk: true });
    });

    it('the path workspace.trig while it is not on disk (a recent entry) opens its folder', async () => {
        const f = files({ workspace: false });
        const store = await opened(join(f.dir, 'workspace.trig'));
        expect(store.files.workspace).toMatchObject({ onDisk: false });
        expect((await new ModelStore().open(join(f.dir, 'other.trig'))).ok).toBe(false);
    });

    it('a workspace file that another program writes later is read', async () => {
        const f = files({ workspace: false });
        const store = await opened(f.dir);
        writeFileSync(join(f.dir, 'workspace.trig'), manifestText.replace(' . }', ' ; <osg://vocab/workspace#placeInstances> "data.ttl" . }'));
        expect(await store.syncFromDisk()).toEqual(['workspace.trig']);
        expect(store.files.placement?.instances).toBe(join(f.dir, 'data.ttl'));
        expect(store.files.workspace).toMatchObject({ onDisk: true });
    });
});
