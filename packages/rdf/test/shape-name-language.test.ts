// The name and description of a property shape and the description of a node shape follow the label language (spec/manifest.hs §6.2
// pickLabel). An edit replaces the literal that the Doc shows and keeps the others (law_nameEditKeepsOtherLanguages).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelStore } from '../src/model-store';
import type { ModelGraph } from '../src/graph';
import { shapesIndexOf } from '../src/shapes-read';

const rdfQuery = createRequire(join(process.cwd(), 'package.json'))('./scripts/rdf-query.cjs') as { rows(files: string | string[], query: string): Record<string, string>[] };

const dirs: string[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const EX = 'http://example.org/', SH = 'http://www.w3.org/ns/shacl#';

/** A shapes file with the node shape ex:ThingShape and its property shape ex:size; `language`: ws:language, if any. */
function workspace(shape: string, property: string, language?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'catenary-shape-language-'));
    dirs.push(dir);
    const f = (name: string, text: string) => writeFileSync(join(dir, name), text);
    f('shapes.ttl', `@prefix sh: <${SH}> . @prefix ex: <${EX}> .
ex:ThingShape a sh:NodeShape ; sh:targetClass ex:Thing ; sh:name "Thing" ; sh:property ex:size ${shape} .
ex:size a sh:PropertyShape ; sh:path ex:size ${property} .\n`);
    f('data.ttl', `<${EX}t1> a <${EX}Thing> .\n`);
    f('workspace.trig', `<urn:name:workspace> { <urn:name:workspace> a <osg://vocab/workspace#Workspace> ;
        <osg://vocab/workspace#defaultFile> "data.ttl"${language ? ` ; <osg://vocab/workspace#language> "${language}"` : ''} . }\n`);
    return { path: join(dir, 'workspace.trig'), shapes: join(dir, 'shapes.ttl') };
}

async function opened(path: string): Promise<ModelStore> {
    const store = new ModelStore();
    store.watching = false;
    const r = await store.open(path);
    if (!r.ok) throw new Error(r.error);
    return store;
}

const ok = (r: { ok: boolean; error?: string }) => { if (!r.ok) throw new Error(r.error); };
/** The shapes read model of the store (shapesIndexOf: in the language of the workspace). */
const shapes = (store: ModelStore) => shapesIndexOf((store as unknown as { graph: ModelGraph }).graph).model;
const property = (store: ModelStore) => Object.values(shapes(store).properties).find(p => p.uri === EX + 'size')!;
const nodeShape = (store: ModelStore) => Object.values(shapes(store).nodeShapes).find(s => s.uri === EX + 'ThingShape')!;
/** The literals of `subject` `predicate` in the file, as "value@tag" ("value" for a plain literal), sorted. */
const literals = (file: string, subject: string, predicate: string) => rdfQuery.rows(file,
    `SELECT ?v ?l WHERE { <${subject}> <${predicate}> ?o . BIND(STR(?o) AS ?v) BIND(LANG(?o) AS ?l) }`)
    .map(r => r.l ? `${r.v}@${r.l}` : r.v).sort();

describe('shape name and description: label language on read, one literal on write', () => {
    it('law_nameEditKeepsOtherLanguages: the name in the setting language; an edit replaces that literal only', async () => {
        const ws = workspace('', '; sh:name "size"@en, "taille"@fr, "Größe"@de', 'fr');
        const store = await opened(ws.path);
        expect(property(store)).toMatchObject({ name: 'taille', nameLanguage: 'fr' });
        ok(store.execute({ kind: 'setPropertyShape', id: property(store).id, patch: { name: 'taille 2' } }));
        ok(await store.save());
        expect(literals(ws.shapes, EX + 'size', SH + 'name')).toEqual(['Größe@de', 'size@en', 'taille 2@fr']);
        expect(property(store)).toMatchObject({ name: 'taille 2', nameLanguage: 'fr' });
    });

    it('without a setting: the plain name; an edit replaces only the plain literal', async () => {
        const ws = workspace('', '; sh:name "size", "taille"@fr, "Größe"@de');
        const store = await opened(ws.path);
        expect(property(store).name).toBe('size');
        expect(property(store).nameLanguage).toBeUndefined();
        ok(store.execute({ kind: 'setPropertyShape', id: property(store).id, patch: { name: 'dimension' } }));
        ok(await store.save());
        expect(literals(ws.shapes, EX + 'size', SH + 'name')).toEqual(['Größe@de', 'dimension', 'taille@fr']);
        // Empty: that literal only goes.
        ok(store.execute({ kind: 'setPropertyShape', id: property(store).id, patch: { name: '' } }));
        ok(await store.save());
        expect(literals(ws.shapes, EX + 'size', SH + 'name')).toEqual(['Größe@de', 'taille@fr']);
    });

    it('a node shape description follows the setting; an edit keeps the other language', async () => {
        const ws = workspace('; sh:description "A thing"@en, "Une chose"@fr', '', 'fr');
        const store = await opened(ws.path);
        expect(nodeShape(store)).toMatchObject({ description: 'Une chose', descriptionLanguage: 'fr' });
        ok(store.execute({ kind: 'setNodeShape', id: nodeShape(store).id, patch: { description: 'Une autre chose' } }));
        ok(await store.save());
        expect(literals(ws.shapes, EX + 'ThingShape', SH + 'description')).toEqual(['A thing@en', 'Une autre chose@fr']);
    });

    it('a property shape without a name: an edit adds one plain literal', async () => {
        const ws = workspace('', '', 'fr');
        const store = await opened(ws.path);
        expect(property(store).name).toBeUndefined();
        ok(store.execute({ kind: 'setPropertyShape', id: property(store).id, patch: { name: 'size' } }));
        ok(await store.save());
        expect(literals(ws.shapes, EX + 'size', SH + 'name')).toEqual(['size']);
    });
});
