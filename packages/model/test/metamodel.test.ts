import { describe, expect, it } from 'vitest';
import { ANY_RESOURCE, mergeContributions, permittedRelations, predicateName, primaryClass, pluginRanges, type Classes, type PluginContributions } from '../src/metamodel';
import { formatPath, shortIri } from '../src/shapes-doc';
import { NS, localName } from '../src/terms';

describe('predicate labels', () => {
    it('decodes urn:name fallbacks but preserves explicit shape names without a prefix', () => {
        const predicate = 'urn:name:related%20item';
        const meta: Classes = { classes: [{
            iri: 'urn:Catalog', name: 'Catalog', shapes: [], fields: [], unsupported: [], color: '', labelInShape: false,
            relations: [{ path: predicate, name: localName(predicate), targetClass: 'urn:Item' }]
        }] };
        expect(predicateName({ classes: [] }, predicate)).toBe('related item');
        expect(predicateName(meta, predicate)).toBe('related item');
        meta.classes[0].relations[0].name = 'Custom relation';
        expect(predicateName(meta, predicate)).toBe('Custom relation');
    });

    it('uses the same prefixed path for instance relations and shape links, even with sh:name', () => {
        const predicate = 'http://www.w3.org/ns/dcat#dataset';
        const meta: Classes = { classes: [{
            iri: 'urn:Catalog', name: 'Catalog', shapes: [], fields: [], unsupported: [], color: '', labelInShape: false,
            relations: [{ path: predicate, name: 'Datasets', targetClass: 'urn:Dataset' }]
        }] };
        expect(predicateName(meta, predicate)).toBe('dcat:dataset');
        expect(predicateName(meta, predicate)).toBe(formatPath({ kind: 'iri', iri: predicate }));
        expect(predicateName({ classes: [] }, predicate)).toBe('dcat:dataset');
        expect(predicateName({ classes: [] }, 'https://unconfigured.example/related')).toBe('related');
    });
});

describe('SKOS terms', () => {
    const meta: Classes = {
        classes: [],
        schemes: [{ iri: 'ex:taskAction', label: 'Task action' }],
        concepts: [{ iri: 'ex:append', label: 'Append', schemes: ['ex:taskAction'], broader: [], top: true }]
    };

    it('a concept of no class of the shapes has no primary class', () => {
        expect(primaryClass(meta, ['http://www.w3.org/2004/02/skos/core#Concept'])).toBeUndefined();
    });
});

describe('plugin merge (mergeContributions)', () => {
    const shacl = (): PluginContributions => ({
        id: 'shacl', classes: [{ iri: 'urn:Task', name: 'Task', sources: ['urn:TaskShape'] }],
        fields: [{ domain: 'urn:Task', predicate: 'urn:title', name: 'title', iri: false, order: 1 }],
        links: [{ domain: 'urn:Task', predicate: 'urn:owner', name: 'owner', target: 'urn:Person' }]
    });

    it('law_shaclWins: for a class and a predicate the first plugin wins; later plugins add links and fields to the class', () => {
        const merged = mergeContributions([shacl(), { id: 'rdfs', classes: [{ iri: 'urn:Task' }],
            links: [{ domain: 'urn:Task', predicate: 'urn:owner', target: 'urn:Team' }, { domain: 'urn:Task', predicate: 'urn:helper', target: 'urn:Person' }],
            fields: [{ domain: 'urn:Task', predicate: 'urn:title' }, { domain: 'urn:Task', predicate: 'urn:due', name: 'due date', datatype: 'urn:date' }] }]);
        const task = merged.classes[0];
        expect(merged.classes).toHaveLength(1);
        expect(task).toMatchObject({ name: 'Task', shapes: ['urn:TaskShape'] });
        expect(task.relations.map(r => [r.path, r.targetClass, r.source])).toEqual([['urn:helper', 'urn:Person', 'rdfs'], ['urn:owner', 'urn:Person', undefined]]);
        expect(task.fields.map(f => [f.path, f.datatype, f.source])).toEqual([['urn:title', undefined, undefined], ['urn:due', 'urn:date', 'rdfs']]);
        expect(task.fields[1].name).toBe('due date');
        expect(permittedRelations(merged, ['urn:Task'], ['urn:Team'])).toEqual([]);
    });

    it('the classes of a plugin follow those of the plugins before it, by order, then name (else the short IRI); colors continue', () => {
        const merged = mergeContributions([shacl(), { id: 'rdfs', classes: [{ iri: 'urn:Agent' }, { iri: 'urn:Team', name: 'Team' }],
            links: [{ domain: 'urn:Team', predicate: 'urn:lead', target: 'urn:Person' }] }]);
        expect(merged.classes.map(c => [c.iri, c.name, c.color])).toEqual([['urn:Task', 'Task', '6'], ['urn:Agent', shortIri('urn:Agent'), '4'], ['urn:Team', 'Team', '5']]);
        expect(merged.classes[2]).toMatchObject({ shapes: [], fields: [], relations: [{ path: 'urn:lead', name: 'lead', source: 'rdfs' }] });
        expect(mergeContributions([{ id: 'shacl', classes: [{ iri: 'urn:B', name: 'B' }, { iri: 'urn:A', name: 'A', order: 2 }] }]).classes.map(c => c.name)).toEqual(['A', 'B']);
    });

    it('a link or field of a class that no plugin gives is dropped; a field of rdfs:label makes the label editable', () => {
        const merged = mergeContributions([{ id: 'shacl', classes: [{ iri: 'urn:Task' }],
            fields: [{ domain: 'urn:Task', predicate: NS.rdfs + 'label' }, { domain: 'urn:Other', predicate: 'urn:size' }] }]);
        expect(merged.classes[0]).toMatchObject({ labelInShape: true, fields: [] });
        expect(pluginRanges(merged, ['urn:Task'])).toEqual([]);
    });

    it('a link without a target admits any resource; a value set without values gets the concepts of its scheme', () => {
        const merged = mergeContributions([shacl(), { id: 'rdfs', links: [{ domain: 'urn:Task', predicate: 'urn:about' }],
            fields: [{ domain: 'urn:Task', predicate: 'urn:about' }] },
        { id: 'skos', links: [{ domain: 'urn:Task', predicate: 'urn:kind', target: NS.skos + 'Concept', valueSet: { iri: 'urn:kinds' } }] }],
        { concepts: [{ iri: 'urn:bug', label: 'Bug', schemes: ['urn:kinds'], broader: [], top: true }] });
        expect(merged.classes[0].fields.find(f => f.path === 'urn:about')).toMatchObject({ iri: false, source: 'rdfs' });
        expect(merged.classes[0].relations.find(r => r.path === 'urn:about')).toMatchObject({ targetClass: ANY_RESOURCE });
        expect(merged.classes[0].relations.find(r => r.path === 'urn:kind')).toMatchObject({ valueSet: 'urn:kinds', values: ['urn:bug'], source: 'skos' });
        expect(permittedRelations(merged, ['urn:Task'], ['urn:Anything']).map(r => r.path)).toEqual(['urn:about']);
        expect(pluginRanges(merged, ['urn:Task'])).toEqual([NS.skos + 'Concept']);
    });
});
