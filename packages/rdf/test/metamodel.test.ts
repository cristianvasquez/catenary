import { describe, expect, it } from 'vitest';
import { classDef, instanceNoun, permittedRelations } from '@catenary/model';
import { formShapes } from '../src/shapes';
import { parseShapes } from './helpers';
import { validate } from '../src/validate';
import { DCAT, DCT, DPROD, PROV, meta, parseQuads } from './helpers';

const DPM = 'osg://vocab/data-product-draft#';

describe('shapes to palette', () => {
    it('makes one palette class per sh:targetClass, named by the class IRI (not sh:name of the shape), ordered by sh:order', async () => {
        const m = await meta();
        expect(m.classes.map(c => c.name)).toEqual(
            ['dprod:DataProduct', 'dcat:Dataset', 'dcat:DataService', 'dpm:NamedGraph', 'prov:Agent', 'dpm:Domain', 'dpm:Task']);
        expect(m.classes.map(instanceNoun)).toEqual(
            ['Data Product', 'Dataset', 'Data Service', 'Named Graph', 'Agent', 'Domain', 'Task']);
        expect(m.classes[0].iri).toBe(DPROD + 'DataProduct');
    });

    it('maps sh:class to relation types and datatype / sh:in / nodeKind to fields', async () => {
        const m = await meta();
        const dp = classDef(m, DPROD + 'DataProduct')!;
        expect(dp.relations.map(r => r.name)).toEqual(
            ['data product owner', 'domain', 'input port', 'output port', 'input dataset', 'output dataset', 'publishes']);
        expect(dp.relations[0]).toMatchObject({ path: DPROD + 'dataProductOwner', targetClass: PROV + 'Agent', minCount: 1, maxCount: 1 });
        expect(dp.fields.map(f => f.name)).toEqual(['description', 'purpose', 'lifecycle status']);
        expect(dp.fields[0]).toMatchObject({ path: DCT + 'description', minCount: 1, iri: false });
        expect(dp.fields[2].in?.map(v => v.value)).toEqual(['Ideation', 'Design', 'Build', 'Deploy', 'Consume']);
        const svc = classDef(m, DCAT + 'DataService')!;
        expect(svc.fields.find(f => f.name === 'endpoint URL')?.iri).toBe(true);
    });

    it('reports non-simple paths as not supported', async () => {
        const m = await meta();
        expect(classDef(m, DCAT + 'Dataset')!.unsupported).toEqual(['produced by: inverse path is not supported']);
    });

    it('offers only permitted relation types for a pair of classes', async () => {
        const m = await meta();
        expect(permittedRelations(m, [DPROD + 'DataProduct'], [DCAT + 'Dataset']).map(r => r.name))
            .toEqual(['input dataset', 'output dataset']);
        expect(permittedRelations(m, [DPROD + 'DataProduct'], [PROV + 'Agent']).map(r => r.name))
            .toEqual(['data product owner']);
        expect(permittedRelations(m, [DCAT + 'Dataset'], [DPROD + 'DataProduct'])).toEqual([]);
        expect(permittedRelations(m, [DPM + 'NamedGraph'], [DCAT + 'DataService']).map(r => r.path))
            .toEqual([DPM + 'exposedThrough']);
    });

    it('names a class by its rdfs:label or skos:prefLabel, else its IRI; shape labels do not count', async () => {
        const m = await parseShapes(`@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <http://ex.org/> .
            @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
            ex:A a sh:NodeShape ; sh:targetClass ex:Alpha ; sh:name "Alpha shape" ; rdfs:label "Alpha shape label" .
            ex:Alpha rdfs:label "Alpha"@de, "Alpha class"@en .
            ex:B a sh:NodeShape ; sh:targetClass ex:Beta ; sh:name "Beta shape" ; sh:property [ sh:path ex:toA ; sh:node ex:A ] .
            ex:G a sh:NodeShape ; sh:targetClass ex:Gamma .
            ex:Gamma skos:prefLabel "Gamma concept" .`);
        expect(m.classes.map(c => c.name)).toEqual(['Alpha class', 'Beta', 'Gamma concept']);
        expect(m.classes[1].relations[0]).toMatchObject({ name: 'toA', targetClass: 'http://ex.org/Alpha' });
    });
});

describe('SKOS concepts in the shapes files', () => {
    const EX = 'http://example.org/';
    const ttl = `
        @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
        @prefix ex: <${EX}> .
        ex:status a skos:ConceptScheme ; skos:prefLabel "Status"@en ; skos:hasTopConcept ex:active .
        ex:active a skos:Concept ; skos:prefLabel "Aktiv"@de, "Active"@en ; skos:narrower ex:running .
        ex:running skos:inScheme ex:status ; skos:definition "It runs." .
        ex:closed a skos:Concept ; skos:topConceptOf ex:status ; skos:notation "C" .
        ex:loose a skos:Concept .`;

    it('reads schemes, labels, top concepts and broader links', async () => {
        const m = await parseShapes(ttl);
        expect(m.schemes).toEqual([{ iri: EX + 'status', label: 'Status', description: undefined }]);
        const c = new Map(m.concepts!.map(x => [x.iri, x]));
        expect(m.concepts!.map(x => x.label)).toEqual(['Active', 'closed', 'loose', 'running']);
        expect(c.get(EX + 'active')).toMatchObject({ top: true, schemes: [EX + 'status'], broader: [] });
        expect(c.get(EX + 'running')).toMatchObject({ top: false, schemes: [EX + 'status'], broader: [EX + 'active'], definition: 'It runs.' });
        expect(c.get(EX + 'closed')).toMatchObject({ top: true, notation: 'C' });
        expect(c.get(EX + 'loose')).toMatchObject({ top: false, schemes: [], broader: [] });
    });
});

describe('properties with a concept scheme or collection as target', () => {
    // As the shapes editor writes them (shape-ops.ts): sh:node to a scheme shape or to a member shape.
    const TTL = `
        @prefix sh: <http://www.w3.org/ns/shacl#> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
        @prefix dct: <http://purl.org/dc/terms/> . @prefix ex: <http://ex/> .
        ex:PersonShape a sh:NodeShape ; sh:targetClass ex:Person ; sh:property ex:PersonShape-color, ex:PersonShape-size .
        ex:PersonShape-color sh:path ex:color ; sh:nodeKind sh:IRI ; sh:node ex:colorsConcept .
        ex:PersonShape-size sh:path ex:size ; sh:nodeKind sh:IRI ; sh:node ex:sizesMember .
        ex:colorsConcept a sh:NodeShape ; sh:property ex:colorsConcept-inScheme .
        ex:colorsConcept-inScheme a sh:PropertyShape ; sh:path skos:inScheme ; sh:hasValue ex:colors .
        ex:colors a skos:ConceptScheme ; skos:prefLabel "Colors" ; skos:hasTopConcept ex:blue .
        ex:red a skos:Concept ; skos:inScheme ex:colors ; skos:prefLabel "Red" .
        ex:blue a skos:Concept ; skos:prefLabel "Blue" .
        ex:other a skos:ConceptScheme . ex:green a skos:Concept ; skos:inScheme ex:other .
        ex:sizes a skos:Collection ; skos:member ex:small .
        ex:sizesMember a sh:NodeShape ; dct:source ex:sizes ; sh:in (ex:small) .
        ex:small a skos:Concept ; skos:prefLabel "Small" .
        ex:PersonShape sh:or (ex:PersonShape-mood ex:PersonShape-home) .
        ex:PersonShape-mood a sh:PropertyShape ; sh:path ex:mood ; sh:node ex:colorsConcept ; sh:minCount 1 .
        ex:PersonShape-home a sh:PropertyShape ; sh:path ex:home ; sh:class ex:Place ; sh:minCount 1 .
    `;
    const EX = 'http://ex/';
    const SKOS_CONCEPT = 'http://www.w3.org/2004/02/skos/core#Concept';

    it('is a relation to skos:Concept, limited to the concepts of the scheme or the members of the collection', async () => {
        const m = await parseShapes(TTL);
        const person = classDef(m, EX + 'Person')!;
        expect(person.unsupported).toEqual([]);
        expect(person.relations.find(r => r.path === EX + 'color')).toMatchObject({ targetClass: SKOS_CONCEPT, valueSet: EX + 'colors', values: [EX + 'blue', EX + 'red'] });
        expect(person.relations.find(r => r.path === EX + 'size')).toMatchObject({ targetClass: SKOS_CONCEPT, valueSet: EX + 'sizes', values: [EX + 'small'] });
        expect(permittedRelations(m, [EX + 'Person'], [SKOS_CONCEPT], EX + 'red').map(r => r.path).sort()).toEqual([EX + 'color', EX + 'mood']);
        expect(permittedRelations(m, [EX + 'Person'], [SKOS_CONCEPT], EX + 'green')).toEqual([]);
    });

    it('includes the members of sh:or as relations, not required each', async () => {
        const person = classDef(await parseShapes(TTL), EX + 'Person')!;
        expect(person.relations.find(r => r.path === EX + 'mood')).toMatchObject({ values: [EX + 'blue', EX + 'red'], minCount: undefined });
        expect(person.relations.find(r => r.path === EX + 'home')).toMatchObject({ targetClass: EX + 'Place', minCount: undefined });
    });

    it('validates a concept of the scheme (the concepts are in the shapes files), and rejects one of another scheme', async () => {
        const m = await parseShapes(TTL);
        const check = async (value: string) => validate(await parseQuads(`<${EX}p> a <${EX}Person> ; <${EX}mood> <${EX}red> ; <${EX}color> <${EX}${value}> .`), m, i => i);
        expect(await check('red')).toEqual([]);
        expect(await check('blue')).toEqual([]);
        expect((await check('green')).map(v => v.path)).toEqual([EX + 'color']);
    });

    it('gives the form sh:in of the allowed values instead of sh:node', async () => {
        const m = await parseShapes(TTL);
        const d = formShapes(m);
        const color = [...d.match(null, null, null)].filter(q => q.subject.value === EX + 'PersonShape-color');
        const preds = [...color].map(q => q.predicate.value.replace(/.*#/, '')).sort();
        expect(preds).toEqual(['in', 'nodeKind', 'path']);
        const inList = [...color].find(q => q.predicate.value.endsWith('#in'))!.object;
        const items: string[] = [];
        for (let cell = inList; cell.value !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';) {
            const next = [...d.match(cell as never, null, null)];
            items.push(next.find(q => q.predicate.value.endsWith('#first'))!.object.value);
            cell = next.find(q => q.predicate.value.endsWith('#rest'))!.object;
        }
        expect(items).toEqual([EX + 'blue', EX + 'red']);
        // The shapes of the store keep sh:node.
        expect([...m.dataset.match(null, null, null)].filter(q => q.subject.value === EX + 'PersonShape-color' && q.predicate.value.endsWith('#node')).length).toBe(1);
    });
});
