// setTypes (spec/manifest.hs §6.2): the classes of instances change in one undo step; the other statements stay.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NS, RDF_TYPE, applicableActions, lockedKey, type ItemFacts } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { parseTrig } from '../src/trig';
import { docOf } from './helpers';

const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
const stores: ModelStore[] = [];
afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const store of stores.splice(0)) await store.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DATASET = 'http://www.w3.org/ns/dcat#Dataset', SERVICE = 'http://www.w3.org/ns/dcat#DataService', NOTE = 'urn:x:Note';
const DESCRIPTION = 'http://purl.org/dc/terms/description';

function workspace() {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-types-'));
    dirs.push(dir);
    const f = (name: string, text: string) => { writeFileSync(join(dir, name), text); return join(dir, name); };
    return {
        official: f('official.ttl', `@prefix rdfs: <${NS.rdfs}> .\n<urn:x:sales> a <${DATASET}> ; rdfs:label "Sales" .\n`),
        own: f('own.ttl', `@prefix rdfs: <${NS.rdfs}> .
<urn:x:a> a <${DATASET}> ; rdfs:label "A" ; <${DESCRIPTION}> "Kept." .
<urn:x:b> a <${DATASET}>, <${NOTE}> ; rdfs:label "B" .
<urn:x:c> a <${NS.skos}Concept>, <${NOTE}> ; rdfs:label "C" .\n`),
        ws: f('workspace.trig', `<urn:name:workspace> { <urn:name:workspace> a <https://cristianvasquez.github.io/catenary/vocab/workspace#Workspace> ;
            <https://cristianvasquez.github.io/catenary/vocab/workspace#defaultFile> "own.ttl" . }\n`),
        other: join(dir, 'other.ttl'),
        read: (name: string) => readFileSync(join(dir, name), 'utf8')
    };
}

async function opened(path: string): Promise<ModelStore> {
    const store = new ModelStore();
    stores.push(store);
    store.watching = false;
    const r = await store.open(path);
    if (!r.ok) throw new Error(r.error);
    return store;
}

const ok = (r: { ok: boolean; error?: string }) => { if (!r.ok) throw new Error(r.error); };
const byLabel = (store: ModelStore, label: string) => Object.values(docOf(store).instances).find(i => i.label === label)!;
const types = (store: ModelStore, label: string) => [...byLabel(store, label).types].sort();

describe('setTypes', () => {
    it('replaces the classes of several instances in one undo step; the IRI, the other values and the file stay', async () => {
        const f = workspace();
        const store = await opened(f.ws);
        const a = byLabel(store, 'A'), b = byLabel(store, 'B');
        ok(store.execute({ kind: 'setTypes', ids: [a.id, b.id], add: [SERVICE], remove: [DATASET, NOTE] }));
        expect(types(store, 'A')).toEqual([SERVICE]);
        expect(types(store, 'B')).toEqual([SERVICE]);
        expect(byLabel(store, 'A').id).toBe(a.id);
        expect(store.reads.properties(a.id)).toMatchObject({ kind: 'instance', fields: { [DESCRIPTION]: [{ value: 'Kept.' }] } });
        await store.idle();
        const written = (await parseTrig(f.read('own.ttl'))).quads.filter(q => q.predicate.value === RDF_TYPE && q.subject.value === 'urn:x:a');
        expect(written.map(q => q.object.value)).toEqual([SERVICE]);
        ok(store.undo());
        expect(types(store, 'A')).toEqual([DATASET]);
        expect(types(store, 'B')).toEqual([DATASET, NOTE].sort());
    });

    it('adds and removes one class; an instance without a class stays an instance', async () => {
        const store = await opened(workspace().ws);
        const a = byLabel(store, 'A');
        ok(store.execute({ kind: 'setTypes', ids: [a.id], add: [NOTE], remove: [] }));
        expect(types(store, 'A')).toEqual([DATASET, NOTE].sort());
        ok(store.execute({ kind: 'setTypes', ids: [a.id], add: [], remove: [DATASET, NOTE] }));
        expect(types(store, 'A')).toEqual([]);
        expect(byLabel(store, 'A').id).toBe(a.id);
    });

    it('a vocabulary type that the command does not name stays (Change Class… removes only the other types)', async () => {
        const store = await opened(workspace().ws);
        ok(store.execute({ kind: 'setTypes', ids: [byLabel(store, 'C').id], add: [SERVICE], remove: [NOTE] }));
        expect(types(store, 'C')).toEqual([NS.skos + 'Concept', SERVICE].sort());
    });

    it('an instance without rdfs:label keeps its last class: a removal that leaves neither is refused', async () => {
        const f = workspace();
        writeFileSync(f.other, `<urn:x:d> a <${NOTE}> ; <${DESCRIPTION}> "Only a description." .\n`);
        const store = await opened(f.ws);
        const d = Object.values(docOf(store).instances).find(i => i.uri === 'urn:x:d')!;
        expect(store.execute({ kind: 'setTypes', ids: [d.id], add: [], remove: [NOTE] }))
            .toMatchObject({ ok: false, error: expect.stringContaining('has no rdfs:label: it keeps at least one class') });
        expect(docOf(store).instances[d.id].types).toEqual([NOTE]);
        ok(store.execute({ kind: 'setTypes', ids: [d.id], add: [SERVICE], remove: [NOTE] }));
        expect(docOf(store).instances[d.id].types).toEqual([SERVICE]);
    });

    it('a replacing class goes to the file of the class it replaces, also for a subject with only type statements', async () => {
        const f = workspace();
        writeFileSync(f.other, `<urn:x:t> a <${NOTE}> .\n`);
        const store = await opened(f.ws);
        const t = Object.values(docOf(store).instances).find(i => i.uri === 'urn:x:t')!;
        ok(store.execute({ kind: 'setTypes', ids: [t.id], add: [SERVICE], remove: [NOTE] }));
        await store.idle();
        const typesIn = async (name: string) => (await parseTrig(f.read(name))).quads
            .filter(q => q.subject.value === 'urn:x:t' && q.predicate.value === RDF_TYPE).map(q => q.object.value);
        expect(await typesIn('other.ttl')).toEqual([SERVICE]);
        expect(await typesIn('own.ttl')).toEqual([]);
    });

    it('refuses a vocabulary type, an IRI without a scheme and an unknown id; the model does not change', async () => {
        const store = await opened(workspace().ws);
        const a = byLabel(store, 'A');
        for (const [add, error] of [
            [NS.skos + 'Concept', 'skos:Concept is a type of a vocabulary: the class of an instance cannot be one.'],
            [NS.sh + 'NodeShape', 'sh:NodeShape is a type of a vocabulary: the class of an instance cannot be one.'],
            ['Dataset', "'Dataset' is not an absolute IRI"]
        ]) {
            const r = store.execute({ kind: 'setTypes', ids: [a.id], add: [add], remove: [DATASET] });
            expect(r).toMatchObject({ ok: false, error });
        }
        expect(store.execute({ kind: 'setTypes', ids: [a.id, 'urn:x:none'], add: [NOTE], remove: [] })).toMatchObject({ ok: false });
        expect(types(store, 'A')).toEqual([DATASET]);
        expect(store.canUndo).toBe(false);
    });

    it('a class in a locked file is refused and names the file', async () => {
        const f = workspace();
        const store = await opened(f.ws);
        ok(await store.setImported('official.ttl', true));
        const sales = byLabel(store, 'Sales');
        const r = store.execute({ kind: 'setTypes', ids: [sales.id], add: [SERVICE], remove: [DATASET] });
        expect(r).toMatchObject({ ok: false, imported: [f.official] });
        expect(types(store, 'Sales')).toEqual([DATASET]);
        // The Properties row shows the class as locked.
        const p = store.reads.properties(sales.id);
        expect(p?.kind === 'instance' ? p.locked : []).toContain(lockedKey(RDF_TYPE, { termType: 'NamedNode', value: DATASET }));
    });
});

describe('Change Class… applicability', () => {
    const item = (kinds: ItemFacts['kinds']): ItemFacts => ({ id: 'x', element: 'x', kinds, types: [], placed: false, placedInActive: false, views: 0, files: 1, unshaped: [] });
    const applies = (...items: ItemFacts[]) => applicableActions({ items }).some(a => a.id === 'catenary.changeClass');

    it('applies to instances only, one or several', () => {
        expect(applies(item(['instance']))).toBe(true);
        expect(applies(item(['instance']), item(['instance']))).toBe(true);
        expect(applies(item(['instance']), item(['view']))).toBe(false);
        expect(applies(item(['instance', 'shape']))).toBe(false);
        expect(applies(item(['relation']))).toBe(false);
    });
});
