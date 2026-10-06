// Problems panel (ADR 0007 step 6): the query of the store compared with the violation list of the validation, on the fixtures.
// The Search panel: search-facets.test.ts.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NS, Violation } from '@catenary/model';
import { ModelStore } from '../src/model-store';
import { DATA, SHAPES, writeWorkspace, docOf } from './helpers';

const MORE = `@prefix skos: <${NS.skos}> . @prefix rdfs: <${NS.rdfs}> .
<urn:k:S> a skos:ConceptScheme ; skos:prefLabel "Scheme" .
<urn:k:a> a skos:Concept ; skos:prefLabel "A" ; skos:topConceptOf <urn:k:S> .
<urn:k:b> a skos:Concept ; skos:prefLabel "B" ; skos:broader <urn:k:a> ; skos:inScheme <urn:k:S> .
<urn:x:two> a <http://www.w3.org/ns/prov#Agent>, <urn:x:Robot> ; rdfs:label "Two types" ; rdfs:comment "multi   line\\n value" .
<urn:x:untyped> rdfs:label "Untyped" ; <urn:x:knows> <urn:x:two> .
<urn:x:task> a <osg://vocab/data-product-draft#Task> ; rdfs:label "Task without action" .
<urn:x:product> a <https://ekgf.github.io/dprod/DataProduct> ; skos:prefLabel "Product without label" .
<urn:x:set> a <http://www.w3.org/ns/dcat#Dataset> ; rdfs:label "Set of a robot" .
<urn:x:two> <https://ekgf.github.io/dprod/outputDataset> <urn:x:set> .
`;

let dir: string, store: ModelStore;
beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'catenary-panels-'));
    writeFileSync(join(dir, 'shapes.ttl'), SHAPES);
    writeFileSync(join(dir, 'data.ttl'), DATA);
    writeFileSync(join(dir, 'more.ttl'), MORE);
    store = new ModelStore();
    store.watching = false;
    expect(await store.open(writeWorkspace(dir))).toEqual({ ok: true });
});
afterEach(async () => {
    await store.idle();
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

/** Run the validation now (the store runs it after a delay). */
async function validate(): Promise<Violation[]> {
    const s = store;
    await s.validate();
    return s.violations;
}

describe('Problems: the results of the report graph', () => {
    it('are the violations of the validation, with the same messages, paths and shapes', async () => {
        const violations = await validate();
        expect(violations.length).toBeGreaterThan(0);
        const key = (v: Violation) => JSON.stringify([v.focus, v.path ?? '', v.component, v.message, v.shape ?? '']);
        const problems = store.problems();
        expect(problems.map(({ label, className, ...v }) => v).map(key).sort()).toEqual(violations.map(key).sort());
        // The same objects: instance, severity, path name; and the order (focus node, then path).
        expect(problems.map(({ label, className, ...v }) => v).sort((a, b) => key(a).localeCompare(key(b))))
            .toEqual([...violations].sort((a, b) => key(a).localeCompare(key(b))));
        expect(problems.map(p => [p.focus, p.path ?? ''])).toEqual(violations.map(v => [v.focus, v.path ?? '']));
        // Fixture coverage: a message of the shape, a message of the engine, a default message (no sh:resultMessage) with sh:value of an
        // inverse path (no path).
        expect(violations.some(v => v.message === 'A data product needs a description.')).toBe(true);
        expect(violations.some(v => v.message === 'Less than 1 values')).toBe(true);
        expect(violations.some(v => v.component === 'Class' && !v.path && v.message.endsWith(': urn:x:two.'))).toBe(true);
    });

    it('have the label and class name of the instance of the focus node', async () => {
        await validate();
        const problems = store.problems();
        expect(problems.some(p => p.instance)).toBe(true);
        for (const p of problems) {
            const inst = p.instance ? docOf(store).instances[p.instance] : undefined;
            expect(p.label).toBe(inst?.label);
            if (inst) expect(p.className).toBe(store.meta.classes.find(c => inst.types.includes(c.iri))?.name ?? inst.types.map(t => t.replace(/^.*[#/:]/, '')).join(', '));
        }
    });

    it('are empty before a validation and without a workspace', () => {
        expect(store.problems()).toEqual([]);
        expect(new ModelStore().problems()).toEqual([]);
    });
});
