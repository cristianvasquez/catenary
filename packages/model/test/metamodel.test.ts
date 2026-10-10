import { describe, expect, it } from 'vitest';
import { ANY_RESOURCE, mergeSchema, permittedRelations, predicateName, primaryClass, schemaRanges, type Classes } from '../src/metamodel';
import { formatPath, shortIri } from '../src/shapes-doc';
import { localName } from '../src/terms';

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

describe('schema rules (mergeSchema)', () => {
    const shapes = (): Classes => ({ classes: [{
        iri: 'urn:Task', name: 'Task', shapes: ['urn:TaskShape'], unsupported: [], color: '6', labelInShape: false,
        fields: [{ path: 'urn:title', name: 'title', iri: false, order: 1 }],
        relations: [{ path: 'urn:owner', name: 'owner', targetClass: 'urn:Person' }]
    }] });

    it('law_shaclWins: the shapes win; other rules add relations and fields to the class', () => {
        const merged = mergeSchema(shapes(), { classes: {}, rules: [
            { domain: 'urn:Task', predicate: 'urn:owner', range: { kind: 'class', iri: 'urn:Team' } },
            { domain: 'urn:Task', predicate: 'urn:title', range: { kind: 'literal' } },
            { domain: 'urn:Task', predicate: 'urn:due', name: 'due date', range: { kind: 'literal', datatype: 'urn:date' } },
            { domain: 'urn:Task', predicate: 'urn:helper', range: { kind: 'class', iri: 'urn:Person' } }
        ] }, 'rdfs');
        const task = merged.classes[0];
        expect(task.relations.map(r => [r.path, r.targetClass, r.source])).toEqual([['urn:helper', 'urn:Person', 'rdfs'], ['urn:owner', 'urn:Person', undefined]]);
        expect(task.fields.map(f => [f.path, f.datatype, f.source])).toEqual([['urn:title', undefined, undefined], ['urn:due', 'urn:date', 'rdfs']]);
        expect(task.fields[1].name).toBe('due date');
        expect(permittedRelations(merged, ['urn:Task'], ['urn:Team'])).toEqual([]);
    });

    it('a class of the rules only follows the classes of the shapes, named by its label, else its short IRI; colors continue', () => {
        const merged = mergeSchema(shapes(), { classes: { 'urn:Team': { name: 'Team' } }, rules: [
            { domain: 'urn:Team', predicate: 'urn:lead', range: { kind: 'class', iri: 'urn:Person' } },
            { domain: 'urn:Agent', predicate: 'urn:name', range: { kind: 'literal' } }
        ] }, 'rdfs');
        expect(merged.classes.map(c => [c.iri, c.name, c.color])).toEqual([['urn:Task', 'Task', '6'], ['urn:Agent', shortIri('urn:Agent'), '4'], ['urn:Team', 'Team', '5']]);
        expect(merged.classes[2]).toMatchObject({ shapes: [], fields: [], relations: [{ path: 'urn:lead', name: 'lead', source: 'rdfs' }] });
    });

    it('literal ranges of one predicate: one field, a datatype only when all ranges have it; no rules: the same metamodel', () => {
        const meta = shapes();
        expect(mergeSchema(meta, { classes: {}, rules: [] }, 'rdfs')).toBe(meta);
        const merged = mergeSchema(meta, { classes: {}, rules: [
            { domain: 'urn:Task', predicate: 'urn:size', range: { kind: 'literal', datatype: 'urn:int' } },
            { domain: 'urn:Task', predicate: 'urn:size', range: { kind: 'literal', datatype: 'urn:string' } }
        ] }, 'rdfs');
        expect(merged.classes[0].fields.filter(f => f.path === 'urn:size').map(f => f.datatype)).toEqual([undefined]);
        expect(meta.classes[0].fields).toHaveLength(1);
        expect(schemaRanges(merged, ['urn:Task'])).toEqual([]);
    });

    it('any value: a field without a datatype and a relation to any resource, which admits an instance of any class', () => {
        const merged = mergeSchema(shapes(), { classes: {}, rules: [{ domain: 'urn:Task', predicate: 'urn:about', range: { kind: 'any' } }] }, 'rdfs');
        expect(merged.classes[0].fields.find(f => f.path === 'urn:about')).toMatchObject({ iri: false, source: 'rdfs' });
        expect(merged.classes[0].relations.find(r => r.path === 'urn:about')).toMatchObject({ targetClass: ANY_RESOURCE });
        expect(permittedRelations(merged, ['urn:Task'], ['urn:Anything']).map(r => r.path)).toEqual(['urn:about']);
        expect(schemaRanges(merged, ['urn:Task'])).toEqual([]);
    });
});
