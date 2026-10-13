// spec/manifest.hs §3.1 law_legacyNamespaceRead: a read of a file with a term in an old Catenary namespace yields the published
// term; a write uses the published namespace only; a view keeps its graph IRI.
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LEGACY_NAMESPACES, NS } from '@catenary/model';
import type { ModelGraph } from '../src/graph';
import { parseTrig } from '../src/trig';
import { rdf } from '../src/terms';
import { openStore, tempWorkspace, workspaceTrig } from './helpers';

const OLD = Object.keys(LEGACY_NAMESPACES);
const iris = (t: { termType: string; value: string; subject?: unknown; predicate?: unknown; object?: unknown }): string[] =>
    t.termType === 'Quad' ? [t.subject, t.predicate, t.object].flatMap(x => iris(x as never)) : t.termType === 'NamedNode' ? [t.value] : [];

it('law_legacyNamespaceRead: old namespaces read as published terms, a save writes the published namespace only', async () => {
    const dir = tempWorkspace({}, 'catenary-legacy-').dir;
    cpSync(new URL('./fixtures/legacy', import.meta.url), dir, { recursive: true });
    const store = await openStore(join(dir, 'workspace.trig'));

    const graph = (store as unknown as { graph: ModelGraph }).graph;
    const view = rdf.namedNode('urn:name:Legacy');
    const quads = graph.match(null, null, null, null);
    // The model has the published terms and no term in an old namespace.
    expect(graph.match(view, rdf.namedNode(NS.rdf + 'type'), rdf.namedNode(NS.view + 'View'), view).length).toBe(1);
    expect(graph.match(rdf.namedNode('urn:name:Legacy/p/1'), rdf.namedNode(NS.view + 'x'), null, view).length).toBe(1);
    expect(quads.flatMap(q => [...iris(q.subject), ...iris(q.predicate), ...iris(q.object)]).filter(i => OLD.some(o => i.startsWith(o)))).toEqual([]);
    // The workspace settings are read from the old namespace.
    expect((store as unknown as { settings: { language?: string } }).settings.language).toBe('en');
    // A file with old terms is changed until the next save.
    expect(store.dirty).toBe(true);

    expect(await store.save()).toEqual({ ok: true });
    expect(store.dirty).toBe(false);
    for (const file of ['workspace.trig', 'views/legacy.view.trig']) {
        const text = readFileSync(join(dir, file), 'utf8');
        expect(text).not.toContain('osg://vocab/');
        const written = (await parseTrig(text)).quads;
        expect(written.flatMap(q => [...iris(q.subject), ...iris(q.predicate), ...iris(q.object)]).filter(i => OLD.some(o => i.startsWith(o)))).toEqual([]);
        if (file === 'workspace.trig') {
            expect(written.some(q => q.predicate.value === NS.ws + 'defaultFile' && q.object.value === 'data.ttl')).toBe(true);
            expect(written.some(q => q.predicate.value === NS.sh + 'namespace' && q.object.value === NS.view)).toBe(true);
        } else {
            // The view keeps its graph IRI.
            expect([...new Set(written.map(q => q.graph.value))]).toEqual(['urn:name:Legacy']);
            expect(written.some(q => q.subject.equals(view) && q.object.value === NS.view + 'View')).toBe(true);
        }
    }
});

it('a workspace file in an old namespace is a workspace file: a folder opens it, and a parent folder does not read it', async () => {
    const dir = tempWorkspace({}, 'catenary-legacy-').dir;
    cpSync(new URL('./fixtures/legacy', import.meta.url), join(dir, 'nested'), { recursive: true });
    renameSync(join(dir, 'nested', 'workspace.trig'), join(dir, 'nested', 'legacy.trig'));
    // The folder opens its only workspace file, whatever its name; its settings are read.
    const nested = await openStore(join(dir, 'nested'));
    expect((nested as unknown as { settings: { path: string; language?: string } }).settings.path).toBe(join(dir, 'nested', 'legacy.trig'));
    expect((nested as unknown as { settings: { language?: string } }).settings.language).toBe('en');
    // A parent workspace stops at the nested workspace: its files are not read, and a save does not write them.
    writeFileSync(join(dir, 'workspace.trig'), workspaceTrig());
    mkdirSync(join(dir, 'own'));
    writeFileSync(join(dir, 'own', 'data.ttl'), '<urn:x:b> a <urn:x:Class> .\n');
    const parent = await openStore(join(dir, 'workspace.trig'));
    expect(parent.files.files.map(f => f.path)).toEqual([join(dir, 'own', 'data.ttl')]);
    expect(parent.files.views).toEqual([]);
    expect(parent.dirty).toBe(false);
});
