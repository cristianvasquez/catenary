import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { iriId, NS, boxes } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { parseQuads } from './helpers';
import { relationId } from '../src/ids';
import { rdf } from '../src/terms';

let dir: string, store: ModelStore;
const type = 'rdfs/class:urn:test:Thing';
const a = iriId('urn:test:a'), b = iriId('urn:test:b');
const relation = relationId(rdf.namedNode('urn:test:a'), rdf.namedNode('urn:test:link'), rdf.namedNode('urn:test:b'));
const prefixes = `@prefix rdfs: <${NS.rdfs}> . @prefix sh: <${NS.sh}> .`;
const textA = `${prefixes}
<urn:test:a> a <urn:test:Thing>; rdfs:label "Alpha Beta"; <urn:test:link> <urn:test:b> .
<urn:test:b> a <urn:test:Thing>; rdfs:label "Another Branch" .`;
const file = (name: string) => join(dir, name + '.ttl');
const ids = (name: string) => store.explorerChildren(type, file(name)).rows.map(r => r.element);
const statements = async (name: string) => (await parseQuads(readFileSync(file(name), 'utf8'))).map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).sort();
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-file-explorer-'));
    writeFileSync(file('a'), textA);
    writeFileSync(file('b'), `${prefixes}<urn:test:destination> a <urn:test:Other>; rdfs:label "Destination" .`);
    writeFileSync(file('c'), `${prefixes}<urn:test:a> a <urn:test:Thing>; rdfs:comment "Other file" . <urn:test:incoming> <urn:test:link> <urn:test:a> .`);
    store = new ModelStore(); store.watching = false;
    expect(await store.open(dir)).toMatchObject({ ok: true });
});
afterEach(async () => { await store.idle(); store.close(); rmSync(dir, { recursive: true, force: true }); });
const move = (elements = [a]) => store.execute({ kind: 'moveElementsToFile', source: file('a'), destination: file('b'), ids: elements });

describe('file explorer', () => {
    it('scopes by supplied subject statements, not external references; the filter searches the scope', () => {
        expect(ids('a')).toEqual([a, b]);
        expect(ids('b')).toEqual([]);
        expect(ids('c')).toEqual([a]);
        expect(store.explorerSearch('albe', file('a')).map(r => r.element)).toEqual([a]);
        expect(store.explorerSearch('albe', file('b'))).toEqual([]);
    });
    it('law_folderDragAll: resolves all contents and deduplicates overlapping selections', () => {
        expect(store.explorerDrag({ file: file('a'), ids: [a], folders: [type, type] }).sort()).toEqual([a, b].sort());
        expect(store.explorerDrag({ file: file('b'), ids: [a], folders: [type] })).toEqual([]);
    });
    it('law_fileTransferOrigins: moves source statements only, persists, and supports one-step undo and redo', async () => {
        const before = await statements('a'), other = await statements('c'), destination = await statements('b');
        expect(move()).toMatchObject({ ok: true });
        expect(ids('a')).toEqual([b]); expect(ids('b')).toContain(a); expect(ids('c')).toEqual([a]);
        await store.idle();
        expect((await statements('a')).every(t => !t.startsWith('urn:test:a '))).toBe(true);
        expect(await statements('b')).toEqual([...destination, ...before.filter(t => t.startsWith('urn:test:a '))].sort());
        expect(await statements('c')).toEqual(other);
        expect(store.undo()).toEqual({ ok: true });
        expect(store.canUndo).toBe(false);
        await store.idle();
        expect(await statements('a')).toEqual(before); expect(await statements('b')).toEqual(destination);
        expect(store.redo()).toEqual({ ok: true });
        await store.idle();
        store.close(); store = new ModelStore(); store.watching = false;
        expect(await store.open(dir)).toMatchObject({ ok: true });
        expect(ids('a')).toEqual([b]); expect(ids('b')).toContain(a); expect(ids('c')).toEqual([a]);
    });
    it('same-file transfer is a no-op and an unknown destination is rejected', () => {
        expect(store.execute({ kind: 'moveElementsToFile', source: file('a'), destination: file('a'), ids: [a] })).toEqual({ ok: true, id: undefined });
        expect(store.canUndo).toBe(false);
        expect(store.execute({ kind: 'moveElementsToFile', source: file('a'), destination: file('missing'), ids: [a] }).ok).toBe(false);
        expect(ids('a')).toEqual([a, b]); expect(store.canUndo).toBe(false);
    });
    it('places a mixed folder selection in one undo step without creating instances', () => {
        const created = store.execute({ kind: 'createView', label: 'Target' });
        expect(created.ok).toBe(true);
        if (!created.ok || !created.id) throw new Error('Missing view');
        const view = created.id;
        expect(store.execute({ kind: 'placeExplorerElements', view, ids: [a, b, relation], at: { x: 100, y: 100 } }).ok).toBe(true);
        expect(boxes(store.viewDoc(view).views[view], 'card').map(c => c.element).sort()).toEqual([a, b].sort());
        expect(store.undo().ok).toBe(true);
        expect(boxes(store.viewDoc(view).views[view], 'card')).toEqual([]);
        expect(ids('a')).toEqual([a, b]);
    });
    it('refuses imported destinations and refuses undo while the source is imported', async () => {
        expect((await store.setImported(file('b'), true)).ok).toBe(true);
        expect(move().ok).toBe(false); expect(store.canUndo).toBe(false); expect(ids('a')).toEqual([a, b]);
        expect((await store.setImported(file('b'), false)).ok).toBe(true);
        expect(move().ok).toBe(true);
        expect((await store.setImported(file('a'), true)).ok).toBe(true);
        expect(store.undo().ok).toBe(false); expect(store.canUndo).toBe(true);
        expect(ids('b')).toContain(a);
    });
    it('moves a relation without moving its endpoints', async () => {
        expect(move([relation]).ok).toBe(true);
        expect(ids('a')).toEqual([a, b]);
        await store.idle();
        expect((await statements('b')).filter(t => t.startsWith('urn:test:a '))).toEqual(['urn:test:a urn:test:link urn:test:b']);
        expect(store.undo().ok).toBe(true);
        await store.idle();
        expect(await statements('a')).toContain('urn:test:a urn:test:link urn:test:b');
    });
    it('does not add a duplicate destination triple and restores an existing destination origin on undo', async () => {
        expect(move().ok).toBe(true);
        expect(store.execute({ kind: 'moveElementsToFile', source: file('c'), destination: file('b'), ids: [a] }).ok).toBe(true);
        expect(ids('c')).toEqual([]);
        expect(store.undo().ok).toBe(true);
        expect(ids('c')).toEqual([a]); expect(ids('b')).toContain(a);
        await store.idle();
        expect((await statements('b')).filter(t => t === 'urn:test:a ' + NS.rdf + 'type urn:test:Thing')).toHaveLength(1);
    });
    it('moves shape structural nodes and restores their graphs with undo', async () => {
        store.close();
        writeFileSync(file('shape'), `${prefixes}<urn:test:S> a sh:NodeShape; sh:targetClass <urn:test:Thing>; sh:property <urn:test:p> .
            <urn:test:p> sh:path <urn:test:name>; sh:datatype <${NS.xsd}string> .`);
        store = new ModelStore(); store.watching = false; await store.open(dir);
        const before = await statements('shape');
        expect(store.execute({ kind: 'moveElementsToFile', source: file('shape'), destination: file('b'), ids: [iriId('urn:test:S')] }).ok).toBe(true);
        await store.idle(); expect(await statements('shape')).toEqual([]);
        expect(await statements('b')).toEqual(expect.arrayContaining(before));
        expect(store.undo().ok).toBe(true);
        await store.idle(); expect(await statements('shape')).toEqual(before);
    });
});
