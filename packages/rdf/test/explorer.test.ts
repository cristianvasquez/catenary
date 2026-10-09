import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPLORER_PAGE, ExplorerRow, NS, VIEW_CLASS, iriId } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';

const AGENT = 'http://www.w3.org/ns/prov#Agent';
const MORE = `@prefix rdfs: <${NS.rdfs}> .
<urn:x:Robot> rdfs:subClassOf <${AGENT}> .
<urn:x:untyped> rdfs:label "Untyped" .
<urn:x:task> a <osg://vocab/data-product-draft#Task> ; rdfs:label "Task without action" .
<urn:x:two> a <${AGENT}>, <urn:x:Robot> ; rdfs:label "Two types" .
<urn:x:A> rdfs:subClassOf <urn:x:B> . <urn:x:B> rdfs:subClassOf <urn:x:A> .
<urn:x:a> a <urn:x:A> ; rdfs:label "In a cycle" .
${Array.from({ length: EXPLORER_PAGE + 5 }, (_, i) => `<urn:x:m${i}> a <urn:x:Many> .`).join('\n')}
`;

let dir: string, store: ModelStore;
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-explorer-'));
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    writeFileSync(join(dir, 'more.ttl'), MORE);
    writeFileSync(join(dir, 'owner.ttl'), `@prefix sh: <${NS.sh}> . <urn:x:S> a sh:NodeShape ; sh:property <urn:x:P> .`);
    writeFileSync(join(dir, 'property.ttl'), `@prefix sh: <${NS.sh}> . <urn:x:P> sh:path <urn:x:q> .`);
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
});
afterEach(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const rows = (key?: string, file?: string) => store.explorerChildren(key, file).rows;
const names = (rs: ExplorerRow[]) => rs.map(r => r.name);
const cls = (iri: string) => 'rdfs/class:' + iri;

describe('Model explorer plugins (ADR 0006)', () => {
    it('the sections of the plugins: Classes (rdfs), then Shapes (shacl)', () => {
        expect(rows().map(r => [r.key, r.name])).toEqual([['rdfs/classes', 'Classes'], ['shacl/shapes', 'Shapes']]);
    });

    it('classes as written: each rdf:type object, a class row is the class element; no class for untyped subjects', () => {
        const all = store.explorerElements('rdfs/classes');
        for (const c of [NS.sh + 'NodeShape', VIEW_CLASS, NS.view + 'Placement', AGENT, 'urn:x:Robot']) expect(all).toContain(iriId(c));
        expect(all).not.toContain(iriId(NS.rdfs + 'Resource'));
        expect(all).not.toContain(iriId('urn:x:untyped'));
        expect(rows('rdfs/classes').find(r => r.key === cls(AGENT))).toMatchObject({ element: iriId(AGENT), folder: true });
    });

    it('subclasses nest under their superclass; an instance shows under each of its classes', () => {
        const agent = rows(cls(AGENT));
        expect(agent[0]).toMatchObject({ key: cls('urn:x:Robot'), name: 'Robot' });
        const typed = Object.values(docOf(store).instances).filter(i => i.types.includes(AGENT)).map(i => i.id).sort();
        expect(agent.filter(r => !r.folder).map(r => r.element).sort()).toEqual(typed);
        expect(names(rows(cls('urn:x:Robot')))).toEqual(['Two types']);
        expect(rows('rdfs/classes').some(r => r.key === cls('urn:x:Robot'))).toBe(false);
        expect(store.explorerPaths(iriId('urn:x:two')).map(p => p.keys)).toEqual([
            ['rdfs/classes', cls(AGENT), 'rdfs/instance:urn:x:two'],
            ['rdfs/classes', cls(AGENT), cls('urn:x:Robot'), 'rdfs/instance:urn:x:two']
        ]);
    });

    it('a subclass cycle keeps a top row', () => {
        const top = rows('rdfs/classes').filter(r => [cls('urn:x:A'), cls('urn:x:B')].includes(r.key));
        expect(top).toHaveLength(1);
        expect(store.explorerElements(top[0].key)).toContain(iriId('urn:x:a'));
        // Reveal paths start at that top row, for each class of the cycle and for its instance.
        for (const id of ['urn:x:A', 'urn:x:B', 'urn:x:a']) {
            const paths = store.explorerPaths(iriId(id));
            expect(paths.length, id).toBeGreaterThan(0);
            for (const p of paths) expect(p.keys[1], id).toBe(top[0].key);
        }
    });

    it('pages of EXPLORER_PAGE rows with the total', () => {
        const first = store.explorerChildren(cls('urn:x:Many'));
        expect(first.total).toBe(EXPLORER_PAGE + 5);
        expect(first.rows).toHaveLength(EXPLORER_PAGE);
        expect(store.explorerChildren(cls('urn:x:Many'), undefined, EXPLORER_PAGE).rows).toHaveLength(5);
    });

    it('a node shape expands to its property shapes', () => {
        const shapes = docOf(store).shapes;
        const shape = Object.values(shapes.nodeShapes).find(s => s.properties.length)!;
        expect(rows('shacl/shapes').map(r => r.element)).toContain(shape.id);
        const props = rows('shacl/shape:' + shape.uri);
        expect(props.map(r => r.element).sort()).toEqual([...shape.properties].sort());
        expect(store.explorerPaths(shape.properties[0]).map(p => p.keys)).toContainEqual(['shacl/shapes', 'shacl/shape:' + shape.uri, props.find(r => r.element === shape.properties[0])!.key]);
    });

    it('a property shape that another file states is a reference: no row in the file of its node shape', () => {
        const props = (file?: string) => store.explorerChildren('shacl/shape:urn:x:S', file && join(dir, file)).rows.map(r => r.key);
        expect(props()).toEqual(['shacl/property:urn:x:P']);
        expect(props('owner.ttl')).toEqual([]);
    });

    it('search: a flat ranked list of element rows, with where each row is', () => {
        const found = store.explorerSearch('two types');
        expect(found[0]).toMatchObject({ name: 'Two types', element: iriId('urn:x:two'), folder: false });
        expect(found[0].description?.split(', ').sort()).toEqual(['Agent', 'Robot']);
        expect(store.explorerSearch('zzzz')).toEqual([]);
    });

    it('the SHACL report is not data: no class, no row', async () => {
        await store.validate();
        expect(store.violations.length).toBeGreaterThan(0);
        expect(store.explorerElements('rdfs/classes')).not.toContain(iriId(NS.sh + 'ValidationResult'));
    });
});
