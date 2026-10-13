import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPLORER_PAGE, ExplorerRow, NS, VIEW_CLASS, iriId } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { docOf } from './helpers';
import { AGENT, EXPLORER_BIG as BIG, Fixture, openExplorerFixture, traced } from './scale-fixtures';

// A new workspace for each test (scale-fixtures.ts). `pnpm test:perf` measures the time of the reads of big.ttl (perf/explorer.perf.ts).
let fixture: Fixture, dir: string, store: ModelStore;
beforeEach(async () => {
    fixture = await openExplorerFixture();
    ({ dir, store } = fixture);
});
afterEach(() => fixture.dispose());

const at = (file: string) => join(dir, file);
const rows = (key: string | undefined, file: string) => store.reads.explorerChildren(key, at(file)).rows;
const elements = (key: string, file: string) => store.reads.explorerElements(key, at(file));
const paths = (id: string, file: string) => store.reads.explorerPaths(iriId(id), at(file)).map(p => p.keys);
const names = (rs: ExplorerRow[]) => rs.map(r => r.name);
const cls = (iri: string) => 'rdfs/class:' + iri;

describe('Model explorer plugins (ADR 0006)', () => {
    it('the sections of the plugins: Classes (rdfs), then Shapes (shacl); a section with no rows of the file is not shown', () => {
        expect(rows(undefined, 'shapes.ttl').map(r => [r.key, r.name])).toEqual([['rdfs/classes', 'Classes'], ['shacl/shapes', 'Shapes']]);
        expect(rows(undefined, 'more.ttl').map(r => r.key)).toEqual(['rdfs/classes']);
    });

    it('a Model document is the document of a file: no file, or a file that is not a model or view file, has no rows', () => {
        expect(store.reads.explorerChildren()).toEqual({ rows: [], total: 0 });
        expect(rows(undefined, 'missing.ttl')).toEqual([]);
        expect(store.reads.explorerSearch('two', undefined)).toEqual([]);
    });

    it('classes as written: each rdf:type object of the file; a class that the file does not describe is a folder, not an element', () => {
        const all = elements('rdfs/classes', 'more.ttl');
        for (const s of ['urn:x:two', 'urn:x:task', 'urn:x:a', 'urn:x:Robot', 'urn:x:A', 'urn:x:B']) expect(all).toContain(iriId(s));
        for (const s of [AGENT, 'urn:x:Many', 'urn:x:untyped', NS.rdfs + 'Resource']) expect(all).not.toContain(iriId(s));
        const agent = rows('rdfs/classes', 'more.ttl').find(r => r.key === cls(AGENT));
        expect(agent?.folder).toBe(true);
        expect(agent).not.toHaveProperty('element');
        // The view vocabulary of a view file: a class folder, not an element of the file.
        const view = rows('rdfs/classes', 'views/product-context.view.trig');
        expect(view.find(r => r.key === cls(VIEW_CLASS))?.folder).toBe(true);
        expect(view.find(r => r.key === cls(VIEW_CLASS))).not.toHaveProperty('element');
    });

    it('subclasses nest under their superclass; an instance shows under each of its classes', () => {
        const agent = rows(cls(AGENT), 'more.ttl');
        expect(agent[0]).toMatchObject({ key: cls('urn:x:Robot'), name: 'Robot', element: iriId('urn:x:Robot') });
        expect(agent.filter(r => !r.folder).map(r => r.element)).toEqual([iriId('urn:x:two')]);
        expect(names(rows(cls('urn:x:Robot'), 'more.ttl'))).toEqual(['Two types']);
        expect(rows('rdfs/classes', 'more.ttl').some(r => r.key === cls('urn:x:Robot'))).toBe(false);
        expect(paths('urn:x:two', 'more.ttl')).toEqual([
            ['rdfs/classes', cls(AGENT), 'rdfs/instance:urn:x:two'],
            ['rdfs/classes', cls(AGENT), cls('urn:x:Robot'), 'rdfs/instance:urn:x:two']
        ]);
    });

    it('a subclass cycle keeps a top row', () => {
        const top = rows('rdfs/classes', 'more.ttl').filter(r => [cls('urn:x:A'), cls('urn:x:B')].includes(r.key));
        expect(top).toHaveLength(1);
        expect(elements(top[0].key, 'more.ttl')).toContain(iriId('urn:x:a'));
        // Reveal paths start at that top row, for each class of the cycle and for its instance.
        for (const id of ['urn:x:A', 'urn:x:B', 'urn:x:a']) {
            const found = paths(id, 'more.ttl');
            expect(found.length, id).toBeGreaterThan(0);
            for (const p of found) expect(p[1], id).toBe(top[0].key);
        }
    });

    it('pages of EXPLORER_PAGE rows with the total', () => {
        const first = store.reads.explorerChildren(cls('urn:x:Many'), at('more.ttl'));
        expect(first.total).toBe(EXPLORER_PAGE + 5);
        expect(first.rows).toHaveLength(EXPLORER_PAGE);
        expect(store.reads.explorerChildren(cls('urn:x:Many'), at('more.ttl'), EXPLORER_PAGE).rows).toHaveLength(5);
    });

    it('a node shape expands to its property shapes', () => {
        const shapes = docOf(store).shapes;
        const shape = Object.values(shapes.nodeShapes).find(s => s.properties.length)!;
        expect(rows('shacl/shapes', 'shapes.ttl').map(r => r.element)).toContain(shape.id);
        const props = rows('shacl/shape:' + shape.uri, 'shapes.ttl');
        expect(props.map(r => r.element).sort()).toEqual([...shape.properties].sort());
        expect(store.reads.explorerPaths(shape.properties[0], at('shapes.ttl')).map(p => p.keys))
            .toContainEqual(['shacl/shapes', 'shacl/shape:' + shape.uri, props.find(r => r.element === shape.properties[0])!.key]);
    });

    it('law_fileRowsOwnSubjects: a node shape whose property shapes are in another file has no property rows', () => {
        expect(rows('shacl/shapes', 'owner.ttl')).toEqual([expect.objectContaining({ element: iriId('urn:x:S'), folder: false, count: 0 })]);
        expect(rows('shacl/shape:urn:x:S', 'owner.ttl')).toEqual([]);
        expect(rows(undefined, 'property.ttl')).toEqual([]);
        expect(store.reads.explorerSearch('P', at('owner.ttl')).map(r => r.element)).not.toContain(iriId('urn:x:P'));
    });

    it('law_fileRowsOwnSubjects: a class declared in another file is a folder of the data file, with the instances of the file', () => {
        const classes = rows('rdfs/classes', 'typed.ttl');
        // The type statement is in the data file: the folder exists. Its label comes from the declaring file.
        expect(classes).toEqual([expect.objectContaining({ key: cls('urn:y:C'), name: 'Declared', folder: true })]);
        expect(classes[0]).not.toHaveProperty('element');
        expect(rows(cls('urn:y:C'), 'typed.ttl').map(r => r.element)).toEqual([iriId('urn:y:i')]);
        // Every row of the file is a subject of the file: the class and the referenced object have no row.
        expect(elements('rdfs/classes', 'typed.ttl')).toEqual([iriId('urn:y:i')]);
        expect(store.reads.explorerSearch('Declared', at('typed.ttl'))).toEqual([]);
        expect(store.reads.explorerDrag({ file: at('typed.ttl'), ids: [], folders: ['rdfs/classes'] })).toEqual([iriId('urn:y:i')]);
        // In the declaring file, the class is an element (an instance of rdfs:Class, a node shape).
        expect(elements('rdfs/classes', 'declared.ttl')).toEqual([iriId('urn:y:C')]);
        expect(rows('shacl/shapes', 'declared.ttl').map(r => r.element)).toEqual([iriId('urn:y:C')]);
    });

    it('search: a flat ranked list of element rows of the file, with where each row is', () => {
        const found = store.reads.explorerSearch('two types', at('more.ttl'));
        expect(found[0]).toMatchObject({ name: 'Two types', element: iriId('urn:x:two'), folder: false });
        expect(found[0].description?.split(', ').sort()).toEqual(['Agent', 'Robot']);
        expect(store.reads.explorerSearch('two types', at('data.ttl'))).toEqual([]);
        expect(store.reads.explorerSearch('zzzz', at('more.ttl'))).toEqual([]);
    });

    it('the SHACL report is not data: no class, no row', async () => {
        await store.validate();
        expect(store.violations.length).toBeGreaterThan(0);
        for (const file of ['data.ttl', 'shapes.ttl', 'more.ttl']) expect(elements('rdfs/classes', file)).not.toContain(iriId(NS.sh + 'ValidationResult'));
    });

    it(`explorerChildren of a file with ${BIG} subjects: a bounded number of SPARQL queries (§11.3 law readBudgetMs)`, () => {
        const key = cls('urn:z:Big');
        store.reads.explorerChildren(key, at('big.ttl'));
        const sections = traced('sections', () => store.reads.explorerChildren(undefined, at('big.ttl')));
        const children = traced('children', () => store.reads.explorerChildren(key, at('big.ttl')));
        expect(children.answer.total).toBe(BIG);
        expect(sections.sparql).toBeLessThanOrEqual(8);
        expect(children.sparql).toBeLessThanOrEqual(8);
        const drag = traced('drag', () => store.reads.explorerDrag({ file: at('big.ttl'), ids: [], folders: ['rdfs/classes'] }));
        expect(drag.answer).toHaveLength(BIG);
        expect(drag.sparql).toBeLessThanOrEqual(8);
    });
});
