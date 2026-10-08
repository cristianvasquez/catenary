import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstanceProperties, NS, PropertyShapeProperties, RelationProperties, Violation, WorkspaceProperties, byLabel, describeProperties, descriptionKey, formPredicates, primaryClass } from '@catenary/model';
import { describeInstance } from '../../model/test/doc-reference';
import { ModelStore } from '../src/model-store';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';
import { rdf } from '../src/terms';
import { S } from '../src/shapes-read';

const SKOS_DATA = `@prefix skos: <${NS.skos}> .
<urn:k:S> a skos:ConceptScheme ; skos:prefLabel "Scheme" .
<urn:k:a> a skos:Concept ; skos:prefLabel "A" ; skos:topConceptOf <urn:k:S> .
<urn:k:b> a skos:Concept ; skos:prefLabel "B" ; skos:broader <urn:k:a> ; skos:inScheme <urn:k:S> .
<urn:x:task> a <osg://vocab/data-product-draft#Task> ; <http://www.w3.org/2000/01/rdf-schema#label> "Task without action" .
`;

let dir: string, store: ModelStore;
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-properties-'));
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

/** The SHACL report graph and the violation list of one validation. */
async function validate(): Promise<Violation[]> {
    const s = store;
    await s.validate();
    return s.violations;
}

const text = (v: { pathName?: string; message: string }) => `${v.pathName && !v.message.includes(v.pathName) ? `${v.pathName}: ` : ''}${v.message}`;

describe('Model properties by SPARQL (ADR 0007 step 2)', () => {
    it('instances: the same label, types, fields, file, shapes and form description as the read model', () => {
        const doc = docOf(store), { meta } = store;
        const ids = Object.keys(doc.instances);
        expect(ids.length).toBeGreaterThan(10);
        const seen = { shapes: 0, fields: 0, targets: 0, form: 0 };
        for (const id of ids) {
            const inst = doc.instances[id];
            const p = store.properties(id) as InstanceProperties;
            seen.shapes += +!!p.shapes.length; seen.fields += +!!Object.keys(p.fields).length; seen.targets += +!!Object.keys(p.targets).length;
            expect(p.kind).toBe('instance');
            expect({ id: p.id, uri: p.uri, label: p.label, types: p.types, fields: p.fields, file: p.file }).toEqual({ ...inst, file: inst.file });
            const shapes = Object.values(doc.shapes.nodeShapes).filter(n => n.targetClass && inst.types.includes(n.targetClass)).sort(byLabel);
            expect(p.shapes.map(s => s.id)).toEqual(shapes.map(s => s.id));
            const cls = primaryClass(meta, inst.types);
            if (cls) expect(descriptionKey(describeProperties(p, formPredicates(cls)))).toBe(descriptionKey(describeInstance(doc, inst, formPredicates(cls))));
            seen.form += +!!cls;
        }
        expect(Object.values(seen).every(n => n > 0)).toBe(true);
    });

    it('instance: lists a target-subject shape as an applicable shape', () => {
        const inst = Object.values(docOf(store).instances)[0];
        const g = (store as unknown as { graph: import('../src/graph').ModelGraph }).graph;
        const shape = rdf.namedNode('urn:test:SubjectShape');
        const predicate = rdf.namedNode('urn:test:status');
        g.add(shape, S.targetSubjectsOf, rdf.namedNode('urn:test:first'), g.shapesGraphs()[0]);
        g.add(shape, S.targetSubjectsOf, predicate, g.shapesGraphs()[0]);
        g.add(rdf.namedNode(inst.uri), predicate, rdf.literal('active'), g.model);

        const p = store.properties(inst.id) as InstanceProperties;
        expect(p.shapes).toContainEqual({ id: expect.any(String), uri: shape.value, label: 'SubjectShape' });
    });

    it('instance: the link candidates of the form are of its sh:class classes and leave out the instance itself', () => {
        const inst = Object.values(docOf(store).instances).find(i => i.label === 'Product usage data')!;
        const p = store.properties(inst.id) as InstanceProperties;
        expect(p.candidates).not.toContain(`<${inst.uri}>`);
        // dprod:DataProduct names dcat:DataService with sh:class (dprod:inputPort).
        const service = Object.values(docOf(store).instances).find(i => i.types.includes('http://www.w3.org/ns/dcat#DataService'))!;
        expect(p.candidates).toContain(`<${service.uri}> <${NS.rdf}type>`);
        // dpm:Task is the sh:class of no property shape.
        expect(p.candidates).not.toContain('<urn:x:task>');
    });

    it('relations: the same ends as the read model; a triple that is not a relation gives nothing', () => {
        const doc = docOf(store);
        const ids = Object.keys(doc.relations);
        expect(ids.length).toBeGreaterThan(5);
        for (const id of ids) {
            const r = doc.relations[id];
            const p = store.properties(id) as RelationProperties;
            expect(p).toMatchObject({ kind: 'relation', predicate: r.predicate });
            expect([p.subject.id, p.subject.label, p.subject.types]).toEqual([r.subject, doc.instances[r.subject].label, doc.instances[r.subject].types]);
            expect([p.object.id, p.object.label, p.object.types]).toEqual([r.object, doc.instances[r.object].label, doc.instances[r.object].types]);
        }
        expect(store.properties('unknown')).toBeUndefined();
    });

    it('violations: the results of the report graph, as the violation list gives them', async () => {
        const violations = await validate();
        const doc = docOf(store);
        let n = 0;
        for (const inst of Object.values(doc.instances)) {
            const expected = violations.filter(v => v.instance === inst.id).map(text).sort();
            const got = (store.properties(inst.id) as InstanceProperties).results.map(text).sort();
            expect(got).toEqual(expected);
            n += got.length;
        }
        expect(n).toBeGreaterThan(0);
        let m = 0;
        for (const id of Object.keys(doc.shapes.properties)) {
            const expected = violations.filter(v => v.shape === id).map(v => `${doc.instances[v.instance ?? '']?.label ?? v.focus}: ${v.message}`).sort();
            const p = store.properties(id) as PropertyShapeProperties;
            expect(p.kind).toBe('propertyShape');
            expect(p.results.map(v => `${v.focusLabel}: ${v.message}`).sort()).toEqual(expected);
            m += expected.length;
        }
        expect(m).toBeGreaterThan(0);
    });

    it('nothing selected: the counts of the read model', async () => {
        const violations = await validate();
        const doc = docOf(store);
        expect(store.properties()).toEqual({
            kind: 'workspace', instances: Object.keys(doc.instances).length, relations: Object.keys(doc.relations).length, views: Object.keys(doc.views).length,
            violations: violations.filter(v => v.severity === 'Violation').length
        } satisfies WorkspaceProperties);
    });
});
