// spec/manifest.hs §3.1 law_legacyNamespaceRead: a read of a file with a term in an old Catenary namespace yields the published
// term; a write uses the published namespace only; a view keeps its graph IRI.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LEGACY_NAMESPACES, NS } from '@catenary/model';
import type { ModelGraph } from '../src/graph';
import { ModelStore } from '../src/model-store';
import { parseTrig } from '../src/trig';
import { rdf } from '../src/terms';

const dirs: string[] = [], stores: ModelStore[] = [];
afterEach(async () => {
    for (const store of stores.splice(0)) { await store.idle(); store.close(); }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OLD = Object.keys(LEGACY_NAMESPACES);
const iris = (t: { termType: string; value: string; subject?: unknown; predicate?: unknown; object?: unknown }): string[] =>
    t.termType === 'Quad' ? [t.subject, t.predicate, t.object].flatMap(x => iris(x as never)) : t.termType === 'NamedNode' ? [t.value] : [];

it('law_legacyNamespaceRead: old namespaces read as published terms, a save writes the published namespace only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-legacy-'));
    dirs.push(dir);
    cpSync(new URL('./fixtures/legacy', import.meta.url), dir, { recursive: true });
    const store = new ModelStore();
    store.watching = false;
    stores.push(store);
    expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });

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
