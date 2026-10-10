import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionTarget, iriId } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { metamodelFromQuads } from '../src/shapes';
import { DATA, SHAPES, parseQuads, writeWorkspace, docOf, violationsIn } from './helpers';

const X = 'urn:x:';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const BOOKS = `@prefix x: <${X}> . @prefix rdfs: <${RDFS}> .
x:a a x:Book ; rdfs:label "A" ; x:pages 100 ; x:author x:p1 .
x:b a x:Book ; rdfs:label "B" ; x:pages 200 ; x:author x:p1, x:p2 ; x:note "n", 3 .
x:p1 a x:Author ; rdfs:label "P1" .
x:p2 a x:Author ; rdfs:label "P2" .
x:Author rdfs:label "Writer" .
x:Book a rdfs:Class .
`;

let dir: string, store: ModelStore;
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-propose-'));
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    writeFileSync(join(dir, 'books.ttl'), BOOKS);
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
});
afterEach(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const state = (t: ActionTarget) => store.selectionActions(t).actions.find(a => a.id === 'catenary.proposeShapes');
const shapeOf = (cls: string) => Object.values(docOf(store).shapes.nodeShapes).find(s => s.targetClass === cls);
const propertiesOf = (shape: string) => Object.fromEntries(Object.values(docOf(store).shapes.properties).filter(p => p.owner === shape)
    .map(p => [p.path.kind === 'iri' ? p.path.iri : JSON.stringify(p.path), { range: p.range, min: p.minCount, max: p.maxCount }]));

describe('Propose Node Shapes from Data (SHACLxtract)', () => {
    it('applies to an instance whose class has no node shape, and to that class; not to rdfs:Class', () => {
        expect(state({ ids: [iriId(X + 'a')] })).toEqual({ id: 'catenary.proposeShapes', enabled: true });
        expect(store.selectionActions({ ids: [iriId(X + 'a')] }).items[0].unshaped).toEqual([X + 'Book']);
        expect(store.selectionActions({ ids: [iriId(X + 'Book')] }).items[0].unshaped).toEqual([X + 'Book']);
        expect(store.selectionActions({ ids: [iriId(RDFS + 'Class')] }).items[0].unshaped).toEqual([]);
        // An instance of a class with a node shape: the action does not apply.
        const targeted = Object.values(docOf(store).shapes.nodeShapes).find(s => s.targetClass)!;
        const instance = Object.values(docOf(store).instances).find(i => i.types.includes(targeted.targetClass!))!;
        expect(state({ ids: [instance.id] })).toBeUndefined();
        expect(state({ ids: [iriId(targeted.targetClass!)] })).toMatchObject({ enabled: false });
    });

    it('extracts one node shape with property shapes from the data; one undo step removes it', () => {
        const before = Object.keys(docOf(store).shapes.nodeShapes).length;
        const r = store.execute({ kind: 'proposeShapes', classes: [X + 'Book'] });
        if (!r.ok) throw new Error(r.error);
        expect(r.ids).toHaveLength(1);
        const shape = docOf(store).shapes.nodeShapes[r.id!];
        expect({ label: shape.label, targetClass: shape.targetClass }).toEqual({ label: 'Book', targetClass: X + 'Book' });
        expect(propertiesOf(shape.id)).toEqual({
            [RDFS + 'label']: { range: { kind: 'datatype', datatype: XSD + 'string' }, min: 1, max: 1 },
            [X + 'pages']: { range: { kind: 'datatype', datatype: XSD + 'integer' }, min: 1, max: 1 },
            [X + 'author']: { range: { kind: 'class', class: X + 'Author' }, min: 1, max: undefined },
            [X + 'note']: { range: { kind: 'or', alternatives: [{ kind: 'datatype', datatype: XSD + 'integer' }, { kind: 'datatype', datatype: XSD + 'string' }] }, min: undefined, max: undefined }
        });
        expect(state({ ids: [iriId(X + 'a')] })).toBeUndefined();
        store.undo();
        expect(Object.keys(docOf(store).shapes.nodeShapes)).toHaveLength(before);
        expect(shapeOf(X + 'Book')).toBeUndefined();
    });

    it('without classes: every class of the data without a node shape; then a second run fails', () => {
        const r = store.execute({ kind: 'proposeShapes' });
        if (!r.ok) throw new Error(r.error);
        expect(shapeOf(X + 'Book')).toBeDefined();
        // The class label names the shape.
        expect(shapeOf(X + 'Author')?.label).toBe('Writer');
        expect(shapeOf(RDFS + 'Class')).toBeUndefined();
        expect(store.execute({ kind: 'proposeShapes' })).toEqual({ ok: false, error: 'Each class of the data has a node shape.' });
    });

    it('two classes with the same label get two shape IRIs', () => {
        const r = store.execute({ kind: 'proposeShapes', classes: [X + 'Book', 'urn:y:Book'] });
        if (!r.ok) throw new Error(r.error);
        expect(new Set(r.ids).size).toBe(2);
    });

    it('the saved files hold the shapes, and the data conforms to the proposed shapes', async () => {
        const r = store.execute({ kind: 'proposeShapes' });
        if (!r.ok) throw new Error(r.error);
        expect((await store.save()).ok).toBe(true);
        // The primary shapes file of the fixture is data.ttl (it has shapes). Read every file as saved.
        const shapes = (await Promise.all(['shapes.ttl', 'data.ttl', 'books.ttl'].map(f => parseQuads(readFileSync(join(dir, f), 'utf8'))))).flat();
        const targets = shapes.filter(q => q.predicate.value === 'http://www.w3.org/ns/shacl#targetClass').map(q => q.object.value);
        expect(targets).toEqual(expect.arrayContaining([X + 'Book', X + 'Author']));
        const data = await parseQuads(BOOKS);
        const violations = await violationsIn(data, metamodelFromQuads(shapes), iri => iri);
        expect(violations).toEqual([]);
        // A negative example: a book without pages.
        const bad = await parseQuads(`<${X}c> a <${X}Book> ; <${RDFS}label> "C" ; <${X}author> <${X}p1> . <${X}p1> a <${X}Author> ; <${RDFS}label> "P1" .`);
        expect((await violationsIn(bad, metamodelFromQuads(shapes), iri => iri)).length).toBeGreaterThan(0);
    });
});
