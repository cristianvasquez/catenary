import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExplorerRow, NS, VIEW_CLASS, boxes, cardOf, classKey } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';

const SKOS_DATA = `@prefix skos: <${NS.skos}> .
<urn:k:S> a skos:ConceptScheme ; skos:prefLabel "Scheme" .
<urn:k:a> a skos:Concept ; skos:prefLabel "A" ; skos:topConceptOf <urn:k:S> .
<urn:k:b> a skos:Concept ; skos:prefLabel "B" ; skos:broader <urn:k:a> ; skos:inScheme <urn:k:S> .
<urn:k:c> a skos:Concept ; skos:prefLabel "C" .
<urn:k:K> a skos:Collection ; skos:prefLabel "Keys" ; skos:member <urn:k:a>, <urn:k:c> .
<urn:x:untyped> <http://www.w3.org/2000/01/rdf-schema#label> "Untyped" .
<urn:x:two> a <http://www.w3.org/ns/prov#Agent>, <urn:x:Robot> ; <http://www.w3.org/2000/01/rdf-schema#label> "Two types" .
<urn:x:task> a <osg://vocab/data-product-draft#Task> ; <http://www.w3.org/2000/01/rdf-schema#label> "Task without action" .
`;

let dir: string, store: ModelStore;
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-explorer-'));
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    writeFileSync(join(dir, 'more.ttl'), SKOS_DATA);
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
});
afterEach(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const names = (rows: ExplorerRow[]) => rows.map(r => r.name);
const row = (rows: ExplorerRow[], key: string) => rows.find(r => r.key === key)!;

describe('Model explorer rules (ADR 0006)', () => {
    it('root: thing and shape types, with configured internals hidden, then Relations and Concepts', () => {
        const root = store.explorerChildren();
        for (const c of [NS.sh + 'NodeShape', NS.sh + 'PropertyShape', VIEW_CLASS, 'urn:x:Robot', NS.skos + 'Concept', NS.rdfs + 'Resource']) expect(root.some(r => r.key === classKey(c))).toBe(true);
        for (const c of ['Placement', 'Frame', 'Note', 'FileRef', 'EntityGroup']) expect(root.some(r => r.key === classKey(NS.view + c))).toBe(false);
        expect(root.slice(-2).map(r => r.key)).toEqual(['relations', 'concepts']);
        expect(root.some(r => r.key === 'no-class')).toBe(false);
        // New Instance: classes of the shapes, classes with members in the model graph, view:View; not sh:NodeShape.
        expect(row(root, classKey('urn:x:Robot')).classIri).toBe('urn:x:Robot');
        expect(row(root, classKey(VIEW_CLASS)).classIri).toBe(VIEW_CLASS);
        expect(row(root, classKey(NS.sh + 'NodeShape')).classIri).toBeUndefined();
    });

    it('a class folder: its written members, not its target shapes; two types give two folders', () => {
        const agent = store.explorerChildren(classKey('http://www.w3.org/ns/prov#Agent'));
        expect(agent.some(r => r.kind === 'shape')).toBe(false);
        const typed = Object.values(docOf(store).instances).filter(i => i.types.includes('http://www.w3.org/ns/prov#Agent')).map(i => i.id).sort();
        expect(agent.filter(r => r.kind === 'instance').map(r => r.element).sort()).toEqual(typed);
        expect(names(store.explorerChildren(classKey('urn:x:Robot')))).toEqual(['Two types']);
        const two = Object.values(docOf(store).instances).find(i => i.uri === 'urn:x:two')!.id;
        expect(store.explorerPaths(two).map(p => p.keys[0]).sort()).toEqual([classKey('http://www.w3.org/ns/prov#Agent'), classKey('urn:x:Robot')]);
    });

    it('views are members of view:View; a node shape expands to its property shapes', () => {
        const views = store.explorerChildren(classKey(VIEW_CLASS));
        expect(views.map(r => r.element).sort()).toEqual(Object.keys(docOf(store).views).sort());
        expect(views.every(r => r.kind === 'view')).toBe(true);
        const shape = store.explorerChildren(classKey(NS.sh + 'NodeShape')).find(r => r.kind === 'shape' && r.folder)!;
        const id = shape.key.slice('shape:'.length);
        expect(store.explorerChildren(shape.key).map(r => r.element)).toEqual(docOf(store).shapes.nodeShapes[id].properties);
    });

    it('relations: the same as the read model, by predicate', () => {
        const predicates = store.explorerChildren('relations');
        const ids = predicates.flatMap(p => store.explorerChildren(p.key).map(r => r.element));
        expect(ids.sort()).toEqual(Object.keys(docOf(store).relations).sort());
        expect(predicates.reduce((n, p) => n + Number(p.badge), 0)).toBe(Object.keys(docOf(store).relations).length);
    });

    it('rdfs:Resource: labeled subjects without a type', () => {
        expect(names(store.explorerChildren(classKey(NS.rdfs + 'Resource')))).toEqual(['Untyped']);
    });

    it('concepts: schemes, No scheme, collections; scheme -> top concepts -> narrower; a collection is flat', () => {
        const concepts = store.explorerChildren('concepts');
        expect(names(concepts)).toEqual(['Scheme', 'No scheme', 'Keys']);
        const top = store.explorerChildren('scheme:urn:k:S');
        expect(names(top)).toEqual(['A']);
        expect(top[0].folder).toBe(true);
        expect(names(store.explorerChildren('concept:urn:k:a'))).toEqual(['B']);
        expect(names(store.explorerChildren('no-scheme'))).toEqual(['C']);
        const keys = store.explorerChildren('collection:urn:k:K');
        expect(names(keys)).toEqual(['A', 'C']);
        expect(keys.every(r => !r.folder)).toBe(true);
        expect(store.explorerPaths(store.explorerChildren('concept:urn:k:a')[0].element!).find(p => p.name === 'Concepts')?.keys)
            .toEqual(['concepts', 'scheme:urn:k:S', 'concept:urn:k:a', 'concept:urn:k:b']);
    });

    it('row state: badge = views with a card, grey = none, the current view', () => {
        const view = Object.values(docOf(store).views)[0];
        const placed = boxes(view, 'card').map(c => c.element).find(e => docOf(store).instances[e])!;
        const inst = docOf(store).instances[placed];
        const cls = inst.types.find(t => store.meta.classes.some(c => c.iri === t))!;
        const r = store.explorerChildren(classKey(cls), view.id).find(x => x.element === placed)!;
        const views = Object.values(docOf(store).views).filter(v => cardOf(v, placed)).length;
        expect(r).toMatchObject({ badge: String(views), muted: false, inView: true });
        expect(store.explorerChildren('no-class')[0]).toMatchObject({ badge: '0', muted: true, inView: false });
    });

    it('violations: the SHACL report is a graph of the store; rows count its results; not data, not saved, not undone', async () => {
        const s = store;
        await s.validate();
        const byFocus = new Map<string, number>();
        for (const v of s.violations) if (v.severity === 'Violation') byFocus.set(v.focus, (byFocus.get(v.focus) ?? 0) + 1);
        expect(byFocus.size).toBeGreaterThan(0);
        const rows = store.explorerChildren().filter(r => r.classIri).flatMap(c => store.explorerChildren(c.key)).filter(r => r.kind === 'instance');
        for (const r of rows) expect(r.problems ?? 0).toBe(byFocus.get(docOf(store).instances[r.element!].uri) ?? 0);
        expect(rows.some(r => (r.problems ?? 0) > 0)).toBe(true);
        // Derived data: no class folder, no read model warning, no undo step, nothing to save.
        expect(store.explorerChildren().some(r => r.key === classKey(NS.sh + 'ValidationResult'))).toBe(false);
        expect(store.snapshot().warnings.some(w => w.includes('urn:trellis:validation'))).toBe(false);
        expect(store.snapshot()).toMatchObject({ canUndo: false, dirty: false });
    });

    it('elements under a folder, at any depth (the delete of elements not placed)', () => {
        const ids = store.explorerElements('concepts');
        for (const c of ['urn:k:a', 'urn:k:b', 'urn:k:c']) expect(ids).toContain(Object.values(docOf(store).instances).find(i => i.uri === c)!.id);
    });
});
