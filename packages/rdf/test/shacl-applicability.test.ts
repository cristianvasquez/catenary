import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstanceProperties, TYPES, boxes, iriId, toSchema } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { writeWorkspace } from './helpers';
import { readShapes } from '../src/shapes-read';
import { parseRdfSync } from 'rdf-files';

const prefix = '@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .';
let dir: string, store: ModelStore;
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-shacl-applicability-'));
    writeFileSync(join(dir, 'shapes.ttl'), prefix + `
        <urn:S> a sh:NodeShape ; sh:targetSubjectsOf <urn:p> ; sh:property <urn:ps> ; sh:node <urn:Same> .
        <urn:ps> sh:path <urn:p> ; sh:node <urn:Value> .
        <urn:Same> a sh:NodeShape .
        <urn:Value> a sh:NodeShape ; sh:property <urn:value> . <urn:value> sh:path <urn:title> ; sh:minCount 1 .
        <urn:Objects> sh:targetObjectsOf <urn:p> ; sh:property <urn:objectName> .
        <urn:objectName> sh:path <urn:title> ; sh:minCount 1 .`);
    writeFileSync(join(dir, 'data.ttl'), prefix + '<urn:a> a <urn:C> ; rdfs:label "A" ; <urn:p> <urn:b> . <urn:b> a <urn:C> ; rdfs:label "B" .');
    store = new ModelStore(); store.watching = false;
    expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
});
afterEach(async () => { await store.idle(); store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('shared SHACL behavior in the application', () => {
    it('Properties, Links, halo counts and pickers agree before and after showing a shape', () => {
        const view = store.execute({ kind: 'createView', label: 'Test' });
        expect(view.ok).toBe(true); if (!view.ok || !view.id) throw new Error('No view.');
        expect(store.execute({ kind: 'addToView', view: view.id, ids: [iriId('urn:b')], at: { x: 0, y: 0 } }).ok).toBe(true);
        const current = store.reads.view(view.id)!, card = boxes(current, 'card')[0];
        const formBefore = store.reads.formData(iriId('urn:b'));
        const props = store.reads.properties(iriId('urn:b')) as InstanceProperties;
        expect(store.reads.formData(iriId('urn:b'))).toBe(formBefore);
        expect(props.shapes.map(s => s.uri).sort()).toEqual(['urn:Objects', 'urn:Value']);
        expect(props.shapes.every(s => s.predicates?.includes('urn:title'))).toBe(true);
        expect(store.hiddenNeighborCounts(current).get(iriId('urn:b'))?.targets).toBe(2);
        expect(store.reads.shapeTargetChoices(view.id, card.id)!.items.flatMap(i => i.ids).sort()).toEqual(props.shapes.map(s => s.id).sort());
        for (const s of props.shapes) expect(store.reads.links([s.id]).instances.map(i => i.id)).toEqual([iriId('urn:b')]);
        expect(store.execute({ kind: 'addToView', view: view.id, ids: [iriId('urn:Value')], at: { x: 500, y: 0 } }).ok).toBe(true);
        expect(store.hiddenNeighborCounts(store.reads.view(view.id)!).get(iriId('urn:b'))?.targets).toBe(1);
        const connections = store.viewApplicability(store.reads.view(view.id)!);
        const schema = toSchema(store.viewDoc(view.id), store.meta, view.id, {
            showHidden: false, violations: [], notation: store.viewFigures(view.id), applicability: connections
        });
        const edge = schema.children!.find(e => e.type === TYPES.TARGETING && e.name === 'sh:node')!;
        expect(edge).toBeDefined();
        expect(edge.sourceId).toBe(card.id);
        expect(edge.details).toContain('Path: <urn:p>');
        expect(edge.details).toContain('Source: a');
        expect(store.reads.view(view.id)!.edges.some(e => e.id === edge.id)).toBe(false);
    });

    it('expands instances from a shape-only canvas', () => {
        const view = store.execute({ kind: 'createView', label: 'Shapes' });
        if (!view.ok || !view.id) throw new Error('No view.');
        store.execute({ kind: 'addToView', view: view.id, ids: [iriId('urn:Value')], at: { x: 0, y: 0 } });
        const current = store.reads.view(view.id)!, card = boxes(current, 'card')[0];
        expect(store.hiddenNeighborCounts(current).get(iriId('urn:Value'))?.targets).toBe(1);
        expect(store.reads.shapeTargetChoices(view.id, card.id)?.items.flatMap(i => i.ids)).toEqual([iriId('urn:b')]);
        store.execute({ kind: 'addToView', view: view.id, ids: [iriId('urn:b')], at: { x: 500, y: 0 } });
        expect(store.reads.shapeTargetChoices(view.id, card.id)).toBeUndefined();
    });

    it('edits object targets and node constraints with undo and reload', async () => {
        const id = iriId('urn:Objects');
        expect(store.execute({ kind: 'setNodeShape', id, patch: { targetObjectsOf: ['urn:p', 'urn:q'], nodes: ['urn:Same'] } }).ok).toBe(true);
        expect(store.reads.shapes().nodeShapes[id]).toMatchObject({ targetObjectsOf: ['urn:p', 'urn:q'], nodes: ['urn:Same'] });
        expect(store.undo().ok).toBe(true);
        expect(store.reads.shapes().nodeShapes[id].targetObjectsOf).toEqual(['urn:p']);
        expect(store.redo().ok).toBe(true);
        await store.idle();
        store.close();
        expect(await store.open(join(dir, 'workspace.trig'))).toEqual({ ok: true });
        expect(store.reads.shapes().nodeShapes[id]).toMatchObject({ targetObjectsOf: ['urn:p', 'urn:q'], nodes: ['urn:Same'] });
    });

    it('validates predicate-targeted shapes with an empty class palette', async () => {
        expect(store.meta.classes).toEqual([]);
        await store.validate();
        expect(store.violations.some(v => v.focus === 'urn:b')).toBe(true);
    });

    it('recognizes target-only and referenced shapes without explicit types', () => {
        const shapes = readShapes(parseRdfSync(prefix + '<urn:A> sh:targetObjectsOf <urn:p>; sh:node <urn:B> . <urn:B> sh:closed true .', 'text/turtle'));
        expect(Object.values(shapes.model.nodeShapes).map(s => s.uri)).toEqual(['urn:A', 'urn:B']);
        expect(shapes.model.nodeShapes[iriId('urn:A')].raw).toEqual([]);
    });

    it('preserves a node reference whose definition is not loaded', () => {
        const shapes = readShapes(parseRdfSync(prefix + '<urn:A> sh:node <urn:external> .', 'text/turtle'));
        expect(shapes.model.nodeShapes[iriId('urn:A')].nodes).toEqual(['urn:external']);
        expect(shapes.model.nodeShapes[iriId('urn:external')]).toBeUndefined();
    });
});
