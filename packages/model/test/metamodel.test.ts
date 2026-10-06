import { describe, expect, it } from 'vitest';
import { conceptPath, conceptRoots, predicateName, primaryClass, type Classes, type ConceptDef } from '../src/metamodel';
import { formatPath } from '../src/shapes-doc';
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

describe('concept tree', () => {
    const c = (iri: string, schemes: string[] = [], broader: string[] = [], top = false): ConceptDef => ({ iri, label: iri, schemes, broader, top });
    const keys = (roots: Map<string, ConceptDef[]>) => Object.fromEntries([...roots].map(([k, v]) => [k, v.map(x => x.iri)]));

    it('top rows: concepts with no broader concept in their scheme; loose concepts under No scheme', () => {
        const concepts = [c('a', ['S']), c('b', ['S'], ['a']), c('x', ['S'], ['other']), c('loose')];
        expect(keys(conceptRoots(concepts))).toEqual({ 'scheme:S': ['a', 'x'], 'no-scheme': ['loose'] });
        expect(conceptPath(concepts, 'b')).toEqual({ folder: 'scheme:S', broader: ['a'] });
    });

    it('a broader cycle without scheme has a row, and a path to each concept of it', () => {
        const concepts = [c('animal', [], ['person']), c('person', [], ['animal'])];
        expect(keys(conceptRoots(concepts))).toEqual({ 'no-scheme': ['animal'] });
        expect(conceptPath(concepts, 'animal')).toEqual({ folder: 'no-scheme', broader: [] });
        expect(conceptPath(concepts, 'person')).toEqual({ folder: 'no-scheme', broader: ['animal'] });
        expect(conceptPath(concepts, 'nothing')).toBeUndefined();
    });

    it('a broader cycle inside a scheme goes to that scheme', () => {
        const concepts = [c('p', ['S'], ['q']), c('q', ['S'], ['p'])];
        expect(keys(conceptRoots(concepts))).toEqual({ 'scheme:S': ['p'] });
    });
});
