// The validation mode of the manifest (ws:validation, spec/manifest.hs §9): off, the elements on the open views, or the model.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VALIDATION_GRAPH } from '../src/graph';
import { elementId } from '../src/ids';
import { ModelStore } from '../src/model-store';
import { manifestQuads, readManifest, NEAR, WS } from '../src/files';
import { parseTrig } from '../src/trig';
import { rdf } from '../src/terms';

const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VIEW = 'urn:ex:view';
const VALIDATION = 'osg://vocab/workspace#validation';

/** Two things without a name (both violate), one of them on the view; `mode`: the manifest value, if any. */
function workspace(mode?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-validation-'));
    dirs.push(dir);
    const f = (name: string, text: string) => writeFileSync(join(dir, name), text);
    f('shapes.ttl', `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <urn:ex:> .
ex:ThingShape a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property ex:ThingShape-name .
ex:ThingShape-name sh:path ex:name ; sh:minCount 1 .\n`);
    f('data.ttl', `@prefix ex: <urn:ex:> .\nex:shown a ex:Thing .\nex:hidden a ex:Thing .\n`);
    f('main.view.trig', `@prefix view: <osg://vocab/view#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<${VIEW}> { <${VIEW}> a view:View ; rdfs:label "Main" .
  <${VIEW}/p/1> a view:Placement ; view:element <urn:ex:shown> ; view:view <${VIEW}> ; view:x 0 ; view:y 0 . }\n`);
    f('workspace.trig', `<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> ;
        <osg://vocab/workspace#defaultFile> "data.ttl" ; <osg://vocab/workspace#placeShapes> "shapes.ttl"${mode ? ` ; <${VALIDATION}> "${mode}"` : ''} . }\n`);
    return { dir, path: join(dir, 'workspace.trig'), read: () => readFileSync(join(dir, 'workspace.trig'), 'utf8') };
}

async function opened(path: string): Promise<ModelStore> {
    const store = new ModelStore();
    store.watching = false;
    const r = await store.open(path);
    if (!r.ok) throw new Error(r.error);
    return store;
}

const ok = (r: { ok: boolean; error?: string }) => { if (!r.ok) throw new Error(r.error); };
const foci = (store: ModelStore) => store.violations.map(v => v.focus).sort();
const reportSize = (store: ModelStore) => (store as unknown as { graph: { store: { match(...a: unknown[]): unknown[] } } })
    .graph.store.match(null, null, null, rdf.namedNode(VALIDATION_GRAPH)).length;

describe('validation mode', () => {
    it('the manifest stores off and views; all is the default and is not written', () => {
        const m = { placement: { shapes: NEAR, concepts: NEAR, instances: NEAR }, exclude: [], imported: [] };
        const values = (validation?: 'off' | 'views' | 'all') => manifestQuads({ ...m, validation }, '/ws/w.trig').filter(q => q.predicate.equals(WS.validation)).map(q => q.object.value);
        expect(values()).toEqual([]);
        expect(values('all')).toEqual([]);
        expect(values('views')).toEqual(['views']);
        expect(readManifest(manifestQuads({ ...m, validation: 'off' }, '/ws/w.trig'), '/ws/w.trig').validation).toBe('off');
        // An unknown value reads as the default.
        const unknown = [rdf.quad(rdf.namedNode('urn:name:workspace'), WS.validation, rdf.literal('some'))];
        expect(readManifest(unknown, '/ws/w.trig').validation).toBeUndefined();
    });

    it('all validates the model', async () => {
        const store = await opened(workspace().path);
        await store.validate();
        expect(store.files.validation).toBe('all');
        expect(foci(store)).toEqual(['urn:ex:hidden', 'urn:ex:shown']);
        expect(store.snapshot().counts.validated).toBeUndefined();
    });

    it('off: no violations, an empty report graph; the setting is written and all validates again', async () => {
        const ws = workspace();
        const store = await opened(ws.path);
        await store.validate();
        expect(reportSize(store)).toBeGreaterThan(0);
        ok(await store.setSettings({ validation: 'off' }));
        await store.validate();
        expect(store.violations).toEqual([]);
        expect(reportSize(store)).toBe(0);
        await store.save();
        const stored = (await parseTrig(ws.read())).quads.filter(q => q.predicate.value === VALIDATION).map(q => q.object.value);
        expect(stored).toEqual(['off']);
        ok(await store.setSettings({ validation: 'all' }));
        await store.validate();
        expect(foci(store)).toEqual(['urn:ex:hidden', 'urn:ex:shown']);
    });

    it('a change of the model does not validate when off', async () => {
        const store = await opened(workspace('off').path);
        await store.validate();
        expect(store.violations).toEqual([]);
        expect(store.files.validation).toBe('off');
    });

    it('views validates the elements on the open views only, and follows the open views', async () => {
        const store = await opened(workspace('views').path);
        await store.validate();
        // No open view: nothing to check.
        expect(store.violations).toEqual([]);
        expect(store.snapshot().counts.validated).toBe(0);
        const view = elementId(rdf.namedNode(VIEW));
        store.setOpenView('client-1', view);
        await store.validate();
        expect(foci(store)).toEqual(['urn:ex:shown']);
        expect(store.snapshot().counts.validated).toBe(1);
        // A second editor on the same view, then the first closes: the view stays open.
        store.setOpenView('client-2', view);
        store.setOpenView('client-1', undefined);
        await store.validate();
        expect(foci(store)).toEqual(['urn:ex:shown']);
        store.setOpenView('client-2', undefined);
        await store.validate();
        expect(store.violations).toEqual([]);
    });

    it('views: a placement on an open view starts a run; a move does not', async () => {
        const store = await opened(workspace('views').path);
        const view = elementId(rdf.namedNode(VIEW));
        store.setOpenView('client-1', view);
        await store.validate();
        expect(foci(store)).toEqual(['urn:ex:shown']);
        const runs = vi.spyOn((store as unknown as { validation: { invalidate(): void } }).validation, 'invalidate');
        ok(store.execute({ kind: 'setBounds', view, bounds: [{ id: elementId(rdf.namedNode('urn:ex:shown')), x: 40 }] }));
        expect(runs).not.toHaveBeenCalled();
        ok(store.execute({ kind: 'addToView', view, ids: [elementId(rdf.namedNode('urn:ex:hidden'))], at: { x: 200, y: 0 } }));
        expect(runs).toHaveBeenCalled();
        await store.validate();
        expect(foci(store)).toEqual(['urn:ex:hidden', 'urn:ex:shown']);
    });

    it('views: the SKOS statements of the shapes files go in only for the open views and the IRIs that the data names', async () => {
        const ws = workspace('views');
        writeFileSync(join(ws.dir, 'shapes.ttl'), `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <urn:ex:> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
ex:ConceptShape a sh:NodeShape ; sh:targetClass skos:Concept ; sh:property ex:ConceptShape-note .
ex:ConceptShape-note sh:path skos:note ; sh:minCount 1 .
ex:scheme a skos:ConceptScheme .
# An sh: statement puts the concept into the shapes graph of the file: its SKOS statements are the vocabulary of validation.
ex:loose a skos:Concept ; skos:inScheme ex:scheme ; sh:name "Loose" .\n`);
        const store = await opened(ws.path);
        await store.validate();
        expect(store.violations).toEqual([]);
        ok(await store.setSettings({ validation: 'all' }));
        await store.validate();
        expect(foci(store)).toEqual(['urn:ex:loose']);
    });

    /**
     * A scheme shape on ex:color (sh:node, skos:inScheme sh:hasValue ex:colors). Only vocab.ttl, a shapes file, says that ex:red and
     * ex:blue are in the scheme (inScheme, hasTopConcept). shown (on the view) has red, other (not on it) has blue, hidden has green (not
     * in the scheme). ex:loose is unrelated vocabulary without the skos:note that the concept shape needs.
     */
    function schemes(mode: 'views' | 'all', vocab: 'own' | 'imported') {
        const ws = workspace(mode === 'views' ? 'views' : undefined);
        const f = (name: string, text: string) => writeFileSync(join(ws.dir, name), text);
        f('shapes.ttl', `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <urn:ex:> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
ex:ThingShape a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property ex:ThingShape-color .
ex:ThingShape-color sh:path ex:color ; sh:node ex:ColorsShape .
ex:ColorsShape a sh:NodeShape ; sh:property ex:ColorsShape-scheme .
ex:ColorsShape-scheme sh:path skos:inScheme ; sh:hasValue ex:colors .
ex:ConceptShape a sh:NodeShape ; sh:targetClass skos:Concept ; sh:property ex:ConceptShape-note .
ex:ConceptShape-note sh:path skos:note ; sh:minCount 1 .\n`);
        // An sh: statement puts each subject into the shapes graph of vocab.ttl: no data file holds the scheme membership.
        f('vocab.ttl', `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <urn:ex:> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
ex:colors a skos:ConceptScheme ; skos:hasTopConcept ex:blue ; sh:name "Colors" .
ex:red a skos:Concept ; skos:inScheme ex:colors ; skos:note "Red." ; sh:name "Red" .
ex:blue a skos:Concept ; skos:note "Blue." ; sh:name "Blue" .
ex:green a skos:Concept ; skos:note "Green." ; sh:name "Green" .
ex:loose a skos:Concept ; skos:inScheme ex:colors ; sh:name "Loose" .\n`);
        f('data.ttl', `@prefix ex: <urn:ex:> .\nex:shown a ex:Thing ; ex:color ex:red .\nex:other a ex:Thing ; ex:color ex:blue .\nex:hidden a ex:Thing ; ex:color ex:green .\n`);
        return async () => {
            const store = await opened(ws.path);
            if (vocab === 'imported') ok(await store.setImported('vocab.ttl', true));
            if (mode === 'views') store.setOpenView('client-1', elementId(rdf.namedNode(VIEW)));
            await store.validate();
            const input = (store as unknown as { validationInput(): { data: { subject: { value: string } }[] } }).validationInput();
            return { store, subjects: new Set(input.data.map(q => q.subject.value)) };
        };
    }

    for (const vocab of ['own', 'imported'] as const) {
        it(`all: scheme membership from a shapes file (${vocab}) is validation data`, async () => {
            const { store, subjects } = await schemes('all', vocab)();
            // red (inScheme) and blue (hasTopConcept) are in the scheme; green is not; loose has no note.
            expect(foci(store)).toEqual(['urn:ex:hidden', 'urn:ex:loose']);
            expect(subjects.has('urn:ex:loose')).toBe(true);
        });

        it(`views: scheme membership from a shapes file (${vocab}) is validation data; unrelated vocabulary is not`, async () => {
            const { store, subjects } = await schemes('views', vocab)();
            // shown is checked and its red is in the scheme. loose, blue and green are not named by the data on the view.
            expect(store.snapshot().counts.validated).toBe(1);
            expect(foci(store)).toEqual([]);
            expect([...subjects].sort()).toEqual(['urn:ex:red', 'urn:ex:shown']);
            // A value outside the scheme on the view is a violation.
            const view = elementId(rdf.namedNode(VIEW));
            ok(store.execute({ kind: 'addToView', view, ids: [elementId(rdf.namedNode('urn:ex:hidden')), elementId(rdf.namedNode('urn:ex:other'))], at: { x: 200, y: 0 } }));
            await store.validate();
            expect(foci(store)).toEqual(['urn:ex:hidden']);
        });
    }

    it('all: the scheme membership of a value from an imported data file is validation data (§9 factsOfTargets)', async () => {
        const ws = workspace();
        const f = (name: string, text: string) => writeFileSync(join(ws.dir, name), text);
        f('shapes.ttl', `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <urn:ex:> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
ex:ThingShape a sh:NodeShape ; sh:targetClass ex:Thing ; sh:property ex:ThingShape-color .
ex:ThingShape-color sh:path ex:color ; sh:node ex:ColorsShape .
ex:ColorsShape a sh:NodeShape ; sh:property ex:ColorsShape-scheme .
ex:ColorsShape-scheme sh:path skos:inScheme ; sh:hasValue ex:colors .\n`);
        // A data file without sh: statements: gray (inScheme) and white (hasTopConcept) are in the scheme.
        f('official.ttl', `@prefix ex: <urn:ex:> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
ex:colors a skos:ConceptScheme ; skos:hasTopConcept ex:white .
ex:gray a skos:Concept ; skos:inScheme ex:colors .\nex:white a skos:Concept .\nex:black a skos:Concept .\n`);
        f('data.ttl', `@prefix ex: <urn:ex:> .\nex:shown a ex:Thing ; ex:color ex:gray .\nex:hidden a ex:Thing ; ex:color ex:white .\nex:other a ex:Thing ; ex:color ex:black .\n`);
        const store = await opened(ws.path);
        ok(await store.setImported('official.ttl', true));
        await store.validate();
        expect(foci(store)).toEqual(['urn:ex:other']);
    });

    it('views: an instance that only an imported file describes is not counted as checked', async () => {
        const ws = workspace('views');
        writeFileSync(join(ws.dir, 'official.ttl'), `@prefix ex: <urn:ex:> .\nex:official a ex:Thing ; ex:name "Official" .\n`);
        const store = await opened(ws.path);
        ok(await store.setImported('official.ttl', true));
        const view = elementId(rdf.namedNode(VIEW));
        ok(store.execute({ kind: 'addToView', view, ids: [elementId(rdf.namedNode('urn:ex:official'))], at: { x: 200, y: 0 } }));
        store.setOpenView('client-1', view);
        await store.validate();
        // shown (own data) is checked; official (imported only) is on the view but not checked.
        expect(store.snapshot().counts.validated).toBe(1);
    });

    it('rejects an unknown mode', async () => {
        const store = await opened(workspace().path);
        const r = await store.setSettings({ validation: 'some' as never });
        expect(r.ok).toBe(false);
        expect(store.files.validation).toBe('all');
    });
});
