// Imported files (manifest ws:imported, spec/manifest.hs §2.6): reads, refused changes, additions in the default file, import.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditCommand, NS, TermJSON, PREFIXES, lockedKey } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { parseRdf } from '../src/files';
import { parseTrig } from '../src/trig';
import { docOf } from './helpers';

const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LABEL = NS.rdfs + 'label', DESCRIPTION = 'http://purl.org/dc/terms/description';

/** A workspace: official.ttl (one dataset), own.ttl (the default file, "Everything else"), a workspace file that sets it. */
function workspace() {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-imported-'));
    dirs.push(dir);
    const f = (name: string, text: string) => { writeFileSync(join(dir, name), text); return join(dir, name); };
    return {
        dir,
        official: f('official.ttl', `@prefix dcat: <http://www.w3.org/ns/dcat#> . @prefix rdfs: <${NS.rdfs}> .
<urn:x:sales> a dcat:Dataset ; rdfs:label "Sales" ; <${DESCRIPTION}> "Official text." .\n`),
        own: f('own.ttl', `@prefix rdfs: <${NS.rdfs}> .\n<urn:x:note> a <urn:x:Note> ; rdfs:label "Note" .\n`),
        ws: f('workspace.trig', `<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> ;
            <osg://vocab/workspace#defaultFile> "own.ttl" . }\n`),
        read: (name: string) => readFileSync(join(dir, name), 'utf8')
    };
}

async function opened(path: string): Promise<ModelStore> {
    const store = new ModelStore();
    store.watching = false;
    const r = await store.open(path);
    if (!r.ok) throw new Error(r.error);
    return store;
}

const ok = (r: { ok: boolean; error?: string }) => { if (!r.ok) throw new Error(r.error); };
const instanceId = (store: ModelStore, label: string) => Object.values(docOf(store).instances).find(i => i.label === label)!.id;
const manifestValues = async (text: string, local: string) => (await parseTrig(text)).quads.filter(q => q.predicate.value === `osg://vocab/workspace#${local}`).map(q => q.object.value);

describe('imported files', () => {
    it('marking as imported stores the path in the manifest; a change of an imported statement is refused as a whole and names the file', async () => {
        const f = workspace();
        const store = await opened(f.ws);
        ok(await store.setImported('official.ttl', true));
        await store.idle();
        expect(await manifestValues(f.read('workspace.trig'), 'imported')).toEqual(['official.ttl']);
        expect(store.files.files.find(x => x.path === f.official)).toMatchObject({ imported: true });
        expect(store.files.files.find(x => x.path === f.own)?.imported).toBeUndefined();
        const before = f.read('official.ttl');
        const sales = instanceId(store, 'Sales');
        // law_rejectionRollsBack: rename, delete and a changed value fail; the store and the file stay as they are.
        const commands: EditCommand[] = [
            { kind: 'rename', id: sales, label: 'Revenue' },
            { kind: 'delete', ids: [sales] },
            { kind: 'setStatements', id: sales, values: { [DESCRIPTION]: [{ termType: 'Literal', value: 'Changed.' }] } }
        ];
        for (const command of commands) {
            const r = store.execute(command);
            expect(r).toMatchObject({ ok: false, imported: [f.official] });
            expect(r.ok ? '' : r.error).toBe('official.ttl is an imported file: the change is not made. To change it, mark it as own in the file navigator.');
        }
        expect(docOf(store).instances[sales].label).toBe('Sales');
        expect(store.canUndo).toBe(false);
        await store.idle();
        expect(f.read('official.ttl')).toBe(before);
    });

    it('a new statement about an imported subject goes to the default file ("Everything else") and can change there', async () => {
        const f = workspace();
        const store = await opened(f.ws);
        ok(await store.setImported('official.ttl', true));
        const sales = instanceId(store, 'Sales');
        const official: TermJSON = { termType: 'Literal', value: 'Official text.' };
        ok(store.execute({ kind: 'setStatements', id: sales, values: { [DESCRIPTION]: [official, { termType: 'Literal', value: 'Our note.' }] } }));
        await store.idle();
        expect(f.read('own.ttl')).toContain('Our note.');
        expect(f.read('official.ttl')).not.toContain('Our note.');
        // The added value is not imported: it changes; the imported one is locked in the properties.
        ok(store.execute({ kind: 'setStatements', id: sales, values: { [DESCRIPTION]: [official, { termType: 'Literal', value: 'Our better note.' }] } }));
        await store.idle();
        expect(f.read('own.ttl')).toContain('Our better note.');
        const p = store.properties(sales);
        expect(p).toMatchObject({ kind: 'instance', importedFiles: [f.official] });
        const locked = p?.kind === 'instance' ? p.locked ?? [] : [];
        expect(locked).toContain(lockedKey(DESCRIPTION, official));
        expect(locked).toContain(lockedKey(LABEL, { termType: 'Literal', value: 'Sales' }));
        expect(locked.some(k => k.includes('better'))).toBe(false);
    });

    it('mark as own: the change is then possible; a file that a glob matches stays imported, with an error that names the glob', async () => {
        const f = workspace();
        const store = await opened(f.ws);
        ok(await store.setSettings({ imported: ['*.ttl'] }));
        const r = await store.setImported('official.ttl', false);
        expect(r).toEqual({ ok: false, error: 'official.ttl stays imported by the glob "*.ttl". Remove the glob in the Workspace settings.' });
        ok(await store.setSettings({ imported: ['official.ttl'] }));
        ok(await store.setImported(f.official, false));
        expect(store.files.imported).toEqual([]);
        ok(store.execute({ kind: 'rename', id: instanceId(store, 'Sales'), label: 'Revenue' }));
        await store.idle();
        expect(f.read('official.ttl')).toContain('"Revenue"');
    });

    it('a workspace file with the legacy ws:protect reads it as ws:imported; a write stores ws:imported', async () => {
        const f = workspace();
        writeFileSync(f.ws, `<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> ;
            <osg://vocab/workspace#defaultFile> "own.ttl" ; <osg://vocab/workspace#protect> "official.ttl" . }\n`);
        const store = await opened(f.ws);
        expect(store.files.imported).toEqual(['official.ttl']);
        ok(await store.setImported('own.ttl', true));
        await store.idle();
        expect(await manifestValues(f.read('workspace.trig'), 'imported')).toEqual(['official.ttl', 'own.ttl']);
        expect(await manifestValues(f.read('workspace.trig'), 'protect')).toEqual([]);
    });

    it('undo and redo of a step that changes a file that is imported now are refused; the step stays (law_settingsNoUndo)', async () => {
        const f = workspace();
        const store = await opened(f.ws);
        const sales = instanceId(store, 'Sales');
        ok(store.execute({ kind: 'rename', id: sales, label: 'Revenue' }));
        ok(await store.setImported('official.ttl', true));
        expect(store.canUndo).toBe(true);
        expect(store.undo()).toMatchObject({ ok: false, imported: [f.official] });
        expect(store.canUndo).toBe(true);
        expect(docOf(store).instances[sales].label).toBe('Revenue');
        ok(await store.setImported('official.ttl', false));
        ok(store.undo());
        expect(docOf(store).instances[sales].label).toBe('Sales');
        ok(await store.setImported('official.ttl', true));
        expect(store.redo()).toMatchObject({ ok: false, imported: [f.official] });
        expect(store.canRedo).toBe(true);
    });

    it('settings: an imported file cannot be a file of new subjects; marking the default file as imported clears it', async () => {
        const f = workspace();
        const store = await opened(f.ws);
        ok(await store.setSettings({ imported: ['official.ttl'] }));
        expect(await store.setSettings({ defaultFile: 'official.ttl' })).toEqual({ ok: false, error: 'official.ttl is an imported file.' });
        expect((await store.setSettings({ placement: { instances: 'official.ttl' } })).ok).toBe(false);
        // A rejected setting in the same change keeps the old globs.
        expect((await store.setSettings({ imported: ['*.ttl'], placement: { shapes: '../outside.ttl' } })).ok).toBe(false);
        expect(store.files.imported).toEqual(['official.ttl']);
        ok(await store.setSettings({ imported: ['official.ttl', 'own.ttl'] }));
        expect(store.files.defaultFile?.set).toBe(false);
        expect(store.files.defaultFile?.path).not.toBe(f.own);
    });

    it('mark as imported in place: a Turtle file with blank nodes is written with IRIs first; a file that Catenary cannot write is refused', async () => {
        const f = workspace();
        writeFileSync(join(f.dir, 'blank.ttl'), `<urn:x:b> <urn:x:p> [ <urn:x:q> "v" ] ; <${LABEL}> "B" .\n`);
        writeFileSync(join(f.dir, 'blank.rdf'), `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="urn:x:c"><rdf:value rdf:parseType="Resource"><rdf:value>w</rdf:value></rdf:value></rdf:Description></rdf:RDF>\n`);
        const store = await opened(f.ws);
        ok(await store.setImported('blank.ttl', true));
        const quads = await parseRdf(f.read('blank.ttl'), join(f.dir, 'blank.ttl'));
        expect(quads.length).toBe(3);
        expect(quads.every(q => q.subject.termType === 'NamedNode' && q.object.termType !== 'BlankNode')).toBe(true);
        const r = await store.setImported('blank.rdf', true);
        expect(r).toEqual({ ok: false, error: 'blank.rdf has blank nodes that Catenary cannot write as IRIs. Import the file instead: Import File writes a copy with IRIs.' });
    });

    it('import: a Turtle copy in imported/ with IRIs for blank nodes, marked as imported; new prefixes go to the workspace, conflicting ones do not', async () => {
        const f = workspace();
        const source = mkdtempSync(join(tmpdir(), 'catenary-source-'));
        dirs.push(source);
        const file = join(source, 'catalog.ttl');
        writeFileSync(file, `@prefix cat: <https://example.org/catalog#> . @prefix dcat: <https://example.org/not-dcat#> . @prefix rdfs: <${NS.rdfs}> .
cat:c1 a cat:Catalog ; rdfs:label "Catalog" ; cat:publisher [ rdfs:label "Office" ] ; dcat:x "y" .\n`);
        const store = await opened(f.ws);
        const r = await store.importFiles([file]);
        expect(r).toEqual({ ok: true, files: [join(f.dir, 'imported', 'catalog.ttl')], prefixes: ['cat'] });
        await store.idle();
        const copy = f.read('imported/catalog.ttl');
        const quads = await parseRdf(copy, join(f.dir, 'imported', 'catalog.ttl'));
        expect(quads).toHaveLength(5);
        expect(quads.some(q => q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode')).toBe(false);
        expect(store.files.imported).toEqual(['imported/catalog.ttl']);
        expect(store.files.files.find(x => x.path.endsWith('catalog.ttl'))).toMatchObject({ imported: true });
        expect(PREFIXES.cat).toBe('https://example.org/catalog#');
        expect(PREFIXES.dcat).toBe('http://www.w3.org/ns/dcat#');
        expect(store.warnings.some(w => w.includes('prefixes not added') && w.includes('dcat:'))).toBe(true);
        const manifest = f.read('workspace.trig');
        expect(await manifestValues(manifest, 'imported')).toEqual(['imported/catalog.ttl']);
        expect((await parseTrig(manifest)).quads.some(q => q.object.value === 'https://example.org/catalog#')).toBe(true);
        // The imported subject is locked; the same name again gets -2.
        expect(store.execute({ kind: 'rename', id: instanceId(store, 'Catalog'), label: 'Other' })).toMatchObject({ ok: false });
        expect(await store.importFiles([file])).toMatchObject({ ok: true, files: [join(f.dir, 'imported', 'catalog-2.ttl')], prefixes: [] });
        expect(await store.importFiles([join(source, 'missing.ttl')])).toMatchObject({ ok: false });
        // Several files in one step; a file that cannot be read imports none of them.
        const other = join(source, 'other.ttl');
        writeFileSync(other, `<urn:x:o> <${LABEL}> "Other" .\n`);
        expect(await store.importFiles([other, join(source, 'missing.ttl')])).toMatchObject({ ok: false });
        expect(existsSync(join(f.dir, 'imported', 'other.ttl'))).toBe(false);
        expect(await store.importFiles([other, file])).toEqual({
            ok: true, files: [join(f.dir, 'imported', 'other.ttl'), join(f.dir, 'imported', 'catalog-3.ttl')], prefixes: []
        });
        expect(store.files.imported).toEqual(['imported/catalog-2.ttl', 'imported/catalog-3.ttl', 'imported/catalog.ttl', 'imported/other.ttl']);
    });

    it('import: an RDF/XML file becomes a Turtle copy (Catenary writes no RDF/XML); its xmlns prefixes join the workspace', async () => {
        const f = workspace();
        const source = mkdtempSync(join(tmpdir(), 'catenary-source-'));
        dirs.push(source);
        const file = join(source, 'register.rdf');
        writeFileSync(file, `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:reg="https://example.org/register#">
  <reg:Entry rdf:about="https://example.org/register#e1"><reg:part rdf:parseType="Resource"><reg:code>A</reg:code></reg:part></reg:Entry>
</rdf:RDF>\n`);
        const store = await opened(f.ws);
        const r = await store.importFiles([file]);
        expect(r).toEqual({ ok: true, files: [join(f.dir, 'imported', 'register.ttl')], prefixes: ['reg'] });
        const copy = join(f.dir, 'imported', 'register.ttl');
        const quads = await parseRdf(f.read('imported/register.ttl'), copy);
        expect(quads).toHaveLength(3);
        expect(quads.some(q => q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode')).toBe(false);
        expect(f.read('imported/register.ttl')).not.toContain('<rdf:RDF');
    });

    it('validation reads own statements, the statements of their subjects and the types of what they refer to; not the rest of imported files', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'catenary-imported-'));
        dirs.push(dir);
        const f = (name: string, text: string) => writeFileSync(join(dir, name), text);
        f('shapes.ttl', `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <urn:ex:> .
ex:ThingShape a sh:NodeShape ; sh:targetClass ex:Thing ;
  sh:property ex:ThingShape-name , ex:ThingShape-owner .
ex:ThingShape-name sh:path ex:name ; sh:minCount 1 .
ex:ThingShape-owner sh:path ex:owner ; sh:class ex:Org .\n`);
        // i1 violates (no name); i3 has a name in the imported file; org1 is an Org there.
        f('big.ttl', `@prefix ex: <urn:ex:> .
ex:i1 a ex:Thing .
ex:i3 a ex:Thing ; ex:name "I3" .
ex:org1 a ex:Org .\n`);
        // Own statements: a valid thing that refers to org1, and a note about the imported i3.
        f('own.ttl', `@prefix ex: <urn:ex:> .
ex:mine a ex:Thing ; ex:name "Mine" ; ex:owner ex:org1 .
ex:i3 ex:note "ours" .\n`);
        f('workspace.trig', `<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> ;
            <osg://vocab/workspace#defaultFile> "own.ttl" ; <osg://vocab/workspace#placeShapes> "shapes.ttl" . }\n`);
        const store = await opened(join(dir, 'workspace.trig'));
        const validation = (store as unknown as { validation: { now(): Promise<void>; violations: { focus: string }[] } }).validation;
        await validation.now();
        expect(validation.violations.map(v => v.focus)).toEqual(['urn:ex:i1']);
        ok(await store.setImported('big.ttl', true));
        await validation.now();
        expect(validation.violations).toEqual([]);
        // The imported statements are still in the store: i1 is still an instance.
        expect(Object.values(docOf(store).instances).map(i => i.uri)).toContain('urn:ex:i1');
    });
});
